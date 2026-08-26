import { describe, expect, it } from 'vitest';
import ar from '../../messages/ar.json';
import en from '../../messages/en.json';
import fr from '../../messages/fr.json';
import { routing } from './routing';

const bundles: Record<string, unknown> = { en, ar, fr };

/** Every leaf of a message bundle, as [dotted.key, value] pairs. */
const leaves = (value: unknown, prefix = ''): [string, unknown][] => {
  if (value === null || typeof value !== 'object') return [[prefix, value]];
  return Object.entries(value).flatMap(([key, child]) =>
    leaves(child, prefix === '' ? key : `${prefix}.${key}`),
  );
};

const keysOf = (bundle: unknown): string[] =>
  leaves(bundle)
    .map(([key]) => key)
    .sort();

describe('message bundles', () => {
  const reference = keysOf(en);

  it('ships a bundle for every configured locale', () => {
    for (const locale of routing.locales) {
      expect(bundles[locale], `missing messages/${locale}.json`).toBeDefined();
    }
  });

  it.each(routing.locales)('%s has exactly the keys en has', (locale) => {
    const keys = keysOf(bundles[locale]);
    expect(
      keys.filter((k) => !reference.includes(k)),
      `extra keys in ${locale}`,
    ).toEqual([]);
    expect(
      reference.filter((k) => !keys.includes(k)),
      `missing keys in ${locale}`,
    ).toEqual([]);
  });

  it.each(routing.locales)('%s has no empty strings', (locale) => {
    const empty = leaves(bundles[locale])
      .filter(([, value]) => typeof value === 'string' && value.trim().length === 0)
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });

  it.each(routing.locales)('%s contains only strings, never a stray null or number', (locale) => {
    const wrongType = leaves(bundles[locale])
      .filter(([, value]) => typeof value !== 'string')
      .map(([key]) => key);
    expect(wrongType).toEqual([]);
  });

  it('flags a value left identical to English in every other locale', () => {
    // A key whose ar and fr values both equal en is almost always a forgotten
    // translation. Proper nouns are the legitimate exception, so this asserts on
    // the exact allowlist rather than on a count — adding a real translation and
    // forgetting to remove it from here both fail loudly.
    const untranslated = Object.fromEntries(leaves(en));
    const arValues = Object.fromEntries(leaves(ar));
    const frValues = Object.fromEntries(leaves(fr));

    const identical = reference.filter(
      (key) => arValues[key] === untranslated[key] && frValues[key] === untranslated[key],
    );

    expect(identical).toEqual(['home.title']);
  });
});
