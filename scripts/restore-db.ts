/**
 * Put a backup back.
 *
 *   pnpm db:restore <file>                       says what it would do
 *   pnpm db:restore <file> --commit              inserts into EMPTY collections
 *   pnpm db:restore <file> --commit --replace    empties them first
 *
 * THE DEFAULT IS TO DO NOTHING, and that is not ceremony. This is the one
 * command in the repository that can overwrite a shop's orders, and it gets run
 * on the worst day somebody has had all month. It says what it found, what is
 * already there, and stops.
 *
 * --commit REFUSES A NON-EMPTY COLLECTION. Restoring on top of live data is how
 * a partial outage becomes a total one: the rows that survived get duplicate-key
 * errors halfway through and the collection ends up neither the old thing nor
 * the new one. Emptying first is a separate word, --replace, so that nobody
 * types it by accident.
 *
 * It refuses a database that is not on this machine unless TAZ_SEED_TARGET names
 * it — the same guard the seeders use, for a much better reason.
 *
 * INDEXES COME BACK FROM THE APPLICATION. `ensureIndexes` runs at startup and
 * creates every one, so start the app once after a restore and they return.
 * Until then the data is correct and the unique constraints are not, which is
 * worth knowing before pointing traffic at it.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { BSON, type Document } from 'mongodb';
import { getConfig } from '../src/platform/config/index.js';
import { closeMongo, getDb } from '../src/platform/mongo/index.js';
import { remoteRefusal } from './guard-remote.js';

const { EJSON } = BSON;
const STRICT = { relaxed: false } as const;

type Line = { c: string; d: Document };

/** Everything in the file, grouped. Backups of this shop fit in memory; orders are small. */
const read = async (file: string): Promise<Map<string, Document[]>> => {
  const byCollection = new Map<string, Document[]>();
  const lines = createInterface({
    input: createReadStream(file).pipe(createGunzip()),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let n = 0;
  for await (const line of lines) {
    n += 1;
    if (line.length === 0) continue;
    let parsed: Line;
    try {
      parsed = EJSON.parse(line, STRICT) as Line;
    } catch (cause) {
      throw new Error(`line ${n} is not readable Extended JSON: ${String(cause)}`);
    }
    const bucket = byCollection.get(parsed.c) ?? [];
    bucket.push(parsed.d);
    byCollection.set(parsed.c, bucket);
  }

  return byCollection;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const replace = args.includes('--replace');
  const file = args.find((arg) => !arg.startsWith('--'));

  if (file === undefined) {
    console.error('Usage: pnpm db:restore <file.ndjson.gz> [--commit] [--replace]');
    process.exitCode = 1;
    return;
  }

  const config = getConfig();

  // Before the connection, so an unreachable host cannot bury the refusal.
  if (commit) {
    const refusal = remoteRefusal({
      uri: config.mongo.uri,
      database: config.mongo.database,
      action: 'restore over the database',
      command: `pnpm db:restore ${args.join(' ')}`,
    });

    if (refusal !== null) {
      console.error(refusal);
      process.exitCode = 1;
      return;
    }
  }

  const backup = await read(file);
  const db = await getDb({ uri: config.mongo.uri, database: config.mongo.database });

  console.warn(`file      ${file}`);
  console.warn(`database  ${config.mongo.database}\n`);
  console.warn('  in file   in database  collection');

  const occupied: string[] = [];
  for (const [name, documents] of [...backup].sort(([a], [b]) => a.localeCompare(b))) {
    const existing = await db.collection(name).countDocuments();
    if (existing > 0) occupied.push(name);
    console.warn(
      `  ${String(documents.length).padStart(7)}  ${String(existing).padStart(11)}  ${name}`,
    );
  }

  if (!commit) {
    console.warn('\nNothing was written. Add --commit to restore.');
    if (occupied.length > 0) {
      console.warn(`--commit will REFUSE while these hold data: ${occupied.join(', ')}`);
      console.warn('Add --replace to empty them first.');
    }
    return;
  }

  if (occupied.length > 0 && !replace) {
    console.error(`\nRefusing: these collections already hold data — ${occupied.join(', ')}.`);
    console.error('Restoring on top of live data leaves a collection that is neither the old');
    console.error('one nor the new one. Add --replace to empty them first, deliberately.');
    process.exitCode = 1;
    return;
  }

  console.warn('');
  for (const [name, documents] of backup) {
    if (replace) {
      const removed = await db.collection(name).deleteMany({});
      console.warn(`  emptied ${name} (${removed.deletedCount} removed)`);
    }
    if (documents.length > 0) await db.collection(name).insertMany(documents, { ordered: false });
    console.warn(`  restored ${documents.length} into ${name}`);
  }

  console.warn('\nDone. Start the app once to recreate the indexes before serving traffic.');
};

main()
  .catch((error: unknown) => {
    console.error('Restore failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeMongo);
