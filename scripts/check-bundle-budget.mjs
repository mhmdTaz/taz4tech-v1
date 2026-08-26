#!/usr/bin/env node
/**
 * Bundle budget.
 *
 * Fails the build when the JavaScript shipped to a browser crosses a ceiling.
 * The point is not the exact number — it is that the number can only move
 * deliberately, in a diff someone reviews. Without this, a storefront gains
 * 30 KB a month and nobody can say which change did it.
 *
 * WHAT IS MEASURED
 * ----------------
 * Next 16 builds with Turbopack, which does NOT emit `app-build-manifest.json`
 * (that was the Webpack-era, per-route file). What it does emit is
 * `build-manifest.json` with the chunks every route loads. So the budget is:
 *
 *   baseline  rootMainFiles — the framework runtime every route pays for
 *   total     every .js under .next/static — the whole client surface
 *
 * `polyfillFiles` is reported but NOT budgeted: it is served `nomodule`, so only
 * a legacy browser downloads it. Counting it would inflate the ceiling by ~39 KB
 * and hide that much real regression headroom from modern users.
 *
 * Sizes are gzipped, because that is what actually crosses the wire.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const NEXT_DIR = '.next';

/**
 * Measured at Phase 0: baseline 127.1 KB, total 179.7 KB.
 * Headroom is deliberate but small. These numbers should come DOWN as the app is
 * optimised — raising one is a decision to review, not a chore to unblock CI.
 */
const BASELINE_BUDGET_KB = 145;
const TOTAL_BUDGET_KB = 200;

const manifestPath = join(NEXT_DIR, 'build-manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`Cannot find ${manifestPath}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const gzippedKb = (relativePath) => {
  const path = join(NEXT_DIR, relativePath);
  if (!existsSync(path) || !statSync(path).isFile()) return 0;
  return gzipSync(readFileSync(path)).length / 1024;
};

const sumKb = (files) => files.reduce((total, file) => total + gzippedKb(file), 0);

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );

const baselineFiles = manifest.rootMainFiles ?? [];
const polyfillFiles = manifest.polyfillFiles ?? [];

const baselineKb = sumKb(baselineFiles);
const polyfillKb = sumKb(polyfillFiles);

const staticDir = join(NEXT_DIR, 'static');
const totalKb = existsSync(staticDir)
  ? walk(staticDir)
      .filter((f) => f.endsWith('.js'))
      .reduce((total, f) => total + gzipSync(readFileSync(f)).length / 1024, 0)
  : 0;

const line = (label, kb, budget) => {
  const over = budget !== null && kb > budget;
  const limit = budget === null ? 'not budgeted' : `budget ${budget} KB`;
  console.log(
    `  ${label.padEnd(28)} ${kb.toFixed(1).padStart(7)} KB   ${limit.padEnd(16)} ${over ? 'OVER' : 'ok'}`,
  );
  return over;
};

console.log('\n  Client JavaScript, gzipped\n');
const baselineOver = line('baseline (every route)', baselineKb, BASELINE_BUDGET_KB);
line('polyfills (nomodule)', polyfillKb, null);
const totalOver = line('total client surface', totalKb, TOTAL_BUDGET_KB);

console.log(`\n  baseline chunks (${baselineFiles.length}):`);
for (const file of baselineFiles) {
  console.log(`    ${gzippedKb(file).toFixed(1).padStart(7)} KB  ${file}`);
}
console.log('');

if (baselineOver || totalOver) {
  console.error('Bundle budget exceeded. Trim the route, or raise the budget deliberately.\n');
  process.exit(1);
}
