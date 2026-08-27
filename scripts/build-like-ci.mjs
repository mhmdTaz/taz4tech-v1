/**
 * `pnpm build`, with no database reachable — the way CI builds.
 *
 *   pnpm build:offline
 *
 * WHY THIS EXISTS
 * ---------------
 * The build job in CI has no MongoDB service, deliberately: a build machine has
 * no business connecting to a production database to generate a page. A
 * developer's machine usually has Mongo running, so `pnpm build` succeeds there
 * whether or not the code depends on a database at build time — and the first
 * anyone hears about a component that does is a red pipeline.
 *
 * That is not hypothetical. The site footer shipped without an opt-out from
 * prerendering, passed `pnpm build` locally, and died in CI on ECONNREFUSED
 * while exporting /ar. This script is the reproduction, kept.
 *
 * The port is one nothing listens on rather than an unroutable address: the
 * driver fails fast on a refused connection and slowly on a black hole, and a
 * check nobody waits for is a check nobody runs.
 */

import { spawn } from 'node:child_process';

const UNREACHABLE = 'mongodb://127.0.0.1:27099';

console.warn(`Building with MONGODB_URI=${UNREACHABLE} — nothing should need it.\n`);

const child = spawn('next', ['build'], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    MONGODB_URI: UNREACHABLE,
    // The rest of the config still has to validate, so give it what CI gives it.
    MONGODB_DB: process.env.MONGODB_DB ?? 'taz4tech_build',
    STORE_ID: process.env.STORE_ID ?? 'taz4tech',
    SITE_URL: process.env.SITE_URL ?? 'https://taz4tech.com',
  },
});

child.on('exit', (code) => {
  if (code !== 0) {
    console.error(
      '\nThe build needed a database. Something rendered at build time that reads one:\n' +
        'call `await connection()` in it, or put it behind a Suspense boundary.',
    );
  }
  process.exitCode = code ?? 1;
});
