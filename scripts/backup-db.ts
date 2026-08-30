/**
 * Take a backup of the whole database, and prove it is readable.
 *
 *   pnpm db:backup                      writes ./backups/<db>-<stamp>.ndjson.gz
 *   pnpm db:backup --out path/to/file   writes it there instead
 *
 * WHY THIS EXISTS
 * ---------------
 * Atlas backs up paid clusters and does NOT back up an M0. Which tier this shop
 * is on is a question only the Atlas console answers — see the README — but the
 * answer does not change what should be true either way: **the orders of a cash
 * business should exist somewhere the vendor does not control.**
 *
 * EJSON, NOT JSON, AND THAT IS THE WHOLE DESIGN
 * ---------------------------------------------
 * `JSON.stringify` on a document from this database turns every Date into a
 * string and every image into a bare base64 string with no type. Restored, the
 * media collection is full of things Zod refuses to parse and every order has a
 * placedAt that is no longer a date. It would look like a backup, weigh about
 * the same as one, and be worthless in the only hour it is ever needed.
 *
 * Extended JSON round-trips both, so this writes that.
 *
 * ONE DOCUMENT PER LINE
 * ---------------------
 * NDJSON, streamed, so a catalogue of photographs is never held in memory at
 * once and a file truncated by a full disk loses its tail rather than all of it.
 *
 * INDEXES ARE NOT DUMPED, deliberately. `ensureIndexes` runs at startup and
 * recreates every one of them, so a restore into an empty database gets them
 * from the application rather than from a copy that can fall behind it.
 *
 * IT VERIFIES WHAT IT WROTE. A backup nobody has read is a hope, so the file is
 * re-read and counted against the live collections before this reports success.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { BSON } from 'mongodb';
import { getConfig } from '../src/platform/config/index.js';
import { closeMongo, getDb } from '../src/platform/mongo/index.js';

const { EJSON } = BSON;

/** Strict mode: relaxed would emit a plain number for a Long and lose precision. */
const STRICT = { relaxed: false } as const;

type Line = { c: string; d: Record<string, unknown> };

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

const readBack = async (file: string): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();
  const lines = createInterface({
    input: createReadStream(file).pipe(createGunzip()),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of lines) {
    if (line.length === 0) continue;
    // Parsed, not counted: a line that is not readable Extended JSON is a
    // corrupt backup, and finding that out here beats finding it out later.
    const parsed = EJSON.parse(line, STRICT) as Line;
    counts.set(parsed.c, (counts.get(parsed.c) ?? 0) + 1);
  }

  return counts;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const outFlag = args.indexOf('--out');
  const config = getConfig();

  const file =
    outFlag === -1
      ? `backups/${config.mongo.database}-${stamp(new Date())}.ndjson.gz`
      : (args[outFlag + 1] ?? '');

  if (file.length === 0) {
    console.error('Usage: pnpm db:backup [--out path/to/file.ndjson.gz]');
    process.exitCode = 1;
    return;
  }

  await mkdir(dirname(file), { recursive: true });

  const db = await getDb({ uri: config.mongo.uri, database: config.mongo.database });
  const collections = (await db.listCollections().toArray()).map((each) => each.name).sort();

  console.warn(`database  ${config.mongo.database}`);
  console.warn(`file      ${file}\n`);

  const live = new Map<string, number>();
  const gzip = createGzip();
  const written = pipeline(gzip, createWriteStream(file));

  for (const name of collections) {
    let n = 0;
    for await (const document of db.collection(name).find({})) {
      const line = `${EJSON.stringify({ c: name, d: document }, STRICT)}\n`;
      // Respect back-pressure: a media collection is bigger than the buffer.
      if (!gzip.write(line)) await new Promise((resolve) => gzip.once('drain', resolve));
      n += 1;
    }
    live.set(name, n);
    console.warn(`  ${String(n).padStart(6)}  ${name}`);
  }

  gzip.end();
  await written;

  const size = (await stat(file)).size;
  console.warn(`\n${(size / 1024).toFixed(1)} KB written. Reading it back.\n`);

  const found = await readBack(file);
  const wrong = collections.filter((name) => (found.get(name) ?? 0) !== live.get(name));

  if (wrong.length > 0) {
    console.error('The file does not contain what was read from the database:\n');
    for (const name of wrong) {
      console.error(`  ${name}: wrote ${live.get(name)}, read back ${found.get(name) ?? 0}`);
    }
    process.exitCode = 1;
    return;
  }

  const total = [...live.values()].reduce((sum, n) => sum + n, 0);
  console.warn(`Verified: ${total} document(s) across ${collections.length} collection(s).`);
  console.warn(`Restore with:  pnpm db:restore ${file}`);
};

main()
  .catch((error: unknown) => {
    console.error('Backup failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeMongo);
