import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Contrast guard for the design tokens.
 *
 * WHY THIS EXISTS
 * ---------------
 * `--color-faint` shipped at #5b6478, which is 3.18:1 on the panel background —
 * a WCAG 2.1 AA failure on every panel heading and the loading text. Nothing
 * caught it until axe ran inside a Playwright shard, five minutes into CI, in a
 * job that needed a Mongo container and a Chromium download to reach the
 * assertion.
 *
 * The arithmetic needs none of that. This runs in the unit suite in
 * milliseconds, so a token that fails contrast fails before the commit.
 *
 * The CSS stays the single source of truth — Tailwind 4 is CSS-first, so these
 * values are read out of globals.css rather than duplicated into TypeScript,
 * where the copy would drift and start guarding nothing.
 */

const css = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8');

const tokens = Object.fromEntries(
  [...css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]),
) as Record<string, string>;

/** WCAG 2.1 relative luminance. */
const luminance = (hex: string): number => {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
};

const contrast = (foreground: string, background: string): number => {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
};

/**
 * Every foreground/background pair the app actually renders.
 *
 * Adding a token is not enough to be covered here — a pair has to be listed, so
 * this stays a record of what is really on screen rather than a combinatorial
 * check of colours nobody uses together.
 */
const TEXT_PAIRS: ReadonlyArray<[fg: string, bg: string, usage: string]> = [
  ['ink', 'void', 'headings and body copy on the page background'],
  ['ink', 'surface', 'field values inside a panel'],
  ['muted', 'void', 'the tagline'],
  ['muted', 'surface', 'field labels inside a panel'],
  ['faint', 'surface', 'panel headings and the loading placeholder'],
  ['accent', 'void', 'the eyebrow above the heading'],
  ['caution', 'surface', 'store-not-configured message'],
  ['negative', 'surface', 'lookup-failed message'],
  ['positive', 'surface', 'success messaging'],
];

/** WCAG 2.1 AA, normal-size text. Large text would be 3:1, but none of these are. */
const AA_NORMAL_TEXT = 4.5;

describe('design token contrast', () => {
  it('parses every colour token out of globals.css', () => {
    // If the CSS format changes and the regex stops matching, every assertion
    // below would pass against an empty palette.
    expect(Object.keys(tokens).length).toBeGreaterThanOrEqual(12);
    expect(tokens.void).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it.each(TEXT_PAIRS)('%s on %s meets WCAG AA (%s)', (fg, bg) => {
    const foreground = tokens[fg];
    const background = tokens[bg];
    expect(foreground, `--color-${fg} is not defined`).toBeDefined();
    expect(background, `--color-${bg} is not defined`).toBeDefined();

    const ratio = contrast(foreground ?? '#000000', background ?? '#ffffff');
    expect(
      ratio,
      `--color-${fg} on --color-${bg} is ${ratio.toFixed(2)}:1, below ${AA_NORMAL_TEXT}:1`,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('keeps the three text tiers visually distinct', () => {
    // Fixing a contrast failure by dragging faint up to muted would pass the
    // check above while destroying the hierarchy it exists to support.
    const onSurface = (name: string) =>
      contrast(tokens[name] ?? '#000000', tokens.surface ?? '#000000');
    expect(onSurface('ink')).toBeGreaterThan(onSurface('muted'));
    expect(onSurface('muted')).toBeGreaterThan(onSurface('faint'));
  });

  it('computes a known ratio correctly', () => {
    // Pins the maths itself: black on white is exactly 21:1.
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });
});
