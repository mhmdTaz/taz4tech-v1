import { spawnSync } from 'node:child_process';
import { MongoClient } from 'mongodb';
import { E2E_ENV } from '../../playwright.config.js';
import { remoteRefusal } from '../../scripts/guard-remote.js';

/**
 * Put the e2e database back to a known state before the suite runs.
 *
 * WHY THIS IS NOT OPTIONAL
 * ------------------------
 * CI gets a fresh MongoDB service per job, so it starts empty every time. A
 * developer's machine does not: every order the suite has ever placed is still
 * there, along with every product an import spec created and every stock row a
 * stock spec wrote. After a day of runs this database held 1,992 orders, and
 * two specs failed in ways that pointed nowhere near accumulated state — a
 * `waitForURL` timeout in a helper, and a settings assertion behind it. Both
 * passed immediately on a clean database.
 *
 * That is the worst kind of failure: it looks like the change under test.
 *
 * IT EMPTIES COLLECTIONS RATHER THAN DROPPING THE DATABASE
 * --------------------------------------------------------
 * Dropping takes the INDEXES with it, and the indexes are load-bearing: the
 * unique one on `idempotencyKey` is what makes a double-tapped checkout one
 * order instead of two. They are created once, when the container boots — so a
 * server already running (which is the normal case locally, since Playwright
 * reuses one) would never recreate them, and the suite would go on passing
 * while the protection was gone. `deleteMany` leaves them alone.
 *
 * The seeds then run exactly as CI runs them, from the same scripts, so there
 * is one description of what a seeded store looks like rather than two.
 */

const seed = (script: string): void => {
  // One string rather than an argv array: with shell: true the array form is
  // concatenated unescaped, which Node deprecated for exactly that reason.
  const run = spawnSync(`npx tsx ${script}`, {
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, ...E2E_ENV },
  });

  if (run.status !== 0) {
    throw new Error(`${script} failed:\n${run.stdout ?? ''}${run.stderr ?? ''}`);
  }
};

export default async function resetDatabase(): Promise<void> {
  const uri = E2E_ENV.MONGODB_URI;
  const database = E2E_ENV.MONGODB_DB;

  // The same guard the seeders use, for the same reason: this empties every
  // collection it finds, and the only thing standing between that and somebody
  // real is which database the environment happens to point at.
  const refusal = remoteRefusal({
    uri,
    database,
    action: 'empty and reseed the e2e database',
    command: 'pnpm test:e2e',
  });

  if (refusal !== null) throw new Error(refusal);

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(database);
    const collections = await db.listCollections().toArray();
    await Promise.all(collections.map((each) => db.collection(each.name).deleteMany({})));
  } finally {
    await client.close();
  }

  seed('scripts/seed.ts');
  seed('scripts/seed-demo.ts');
}
