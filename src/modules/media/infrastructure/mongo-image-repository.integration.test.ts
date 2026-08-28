import { type Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { usesIndex, winningStages } from '@/test-support/explain';
import { createStoredImage, type StoredImage } from '../domain/image';
import {
  createMongoImageRepository,
  ensureMediaIndexes,
  MEDIA_COLLECTION,
} from './mongo-image-repository';

const URI = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_TEST_DB ?? 'taz4tech_test';

let client: MongoClient;
let db: Db;

const image = (
  overrides: { id?: string; bytes?: Uint8Array; storeId?: string } = {},
): StoredImage => {
  const result = createStoredImage({
    storeId: overrides.storeId ?? 'taz4tech',
    id: overrides.id ?? 'a'.repeat(64),
    contentType: 'image/png',
    bytes: overrides.bytes ?? new Uint8Array([137, 80, 78, 71]),
    storedAt: new Date('2026-08-28T10:00:00Z'),
  });
  if (!result.ok) throw new Error(`fixture rejected: ${result.error.tag}`);
  return result.value;
};

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 5_000 });
  await client.connect();
  db = client.db(DB_NAME);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db
    .collection(MEDIA_COLLECTION)
    .drop()
    .catch(() => undefined);
  await ensureMediaIndexes(db);
});

describe('MongoImageRepository', () => {
  it('round-trips the bytes exactly', async () => {
    // The whole point. A picture that comes back one byte different is a picture
    // that does not render.
    const repository = createMongoImageRepository(db);
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);

    await repository.save(image({ bytes }));
    const found = await repository.findById('taz4tech', 'a'.repeat(64));

    expect(found?.bytes).toEqual(bytes);
    expect(found?.byteLength).toBe(6);
    expect(found?.contentType).toBe('image/png');
  });

  it('returns null for an id nobody stored', async () => {
    const repository = createMongoImageRepository(db);
    expect(await repository.findById('taz4tech', 'b'.repeat(64))).toBeNull();
  });

  it('will not hand another tenant its bytes', async () => {
    const repository = createMongoImageRepository(db);
    await repository.save(image({ storeId: 'taz4tech' }));

    expect(await repository.findById('somebody-else', 'a'.repeat(64))).toBeNull();
    expect(await repository.exists('somebody-else', 'a'.repeat(64))).toBe(false);
  });

  it('is idempotent: storing the same image twice stores it once', async () => {
    /*
     * The id IS the hash of the bytes, so a second write is the same write.
     * Re-importing last month's spreadsheet must not rewrite megabytes.
     */
    const repository = createMongoImageRepository(db);

    await repository.save(image());
    await repository.save(image());

    expect(await db.collection(MEDIA_COLLECTION).countDocuments()).toBe(1);
  });

  it('does not move the timestamp when the same bytes arrive again', async () => {
    const repository = createMongoImageRepository(db);
    await repository.save(image());

    const later = { ...image(), storedAt: new Date('2027-01-01T00:00:00Z') };
    await repository.save(later);

    const found = await repository.findById('taz4tech', 'a'.repeat(64));
    expect(found?.storedAt).toEqual(new Date('2026-08-28T10:00:00Z'));
  });

  it('answers `exists` without dragging the bytes back out', async () => {
    /*
     * Re-importing a spreadsheet asks this once per row and the answer is almost
     * always yes. Without the projection, each of those answers pulls the whole
     * image out of the database to be thrown away.
     */
    const repository = createMongoImageRepository(db);
    await repository.save(image({ bytes: new Uint8Array(200_000) }));

    expect(await repository.exists('taz4tech', 'a'.repeat(64))).toBe(true);

    const plan = await db
      .collection(MEDIA_COLLECTION)
      .find({ _id: 'a'.repeat(64), storeId: 'taz4tech' } as never)
      .project({ _id: 1 })
      .explain('executionStats');

    // Served from the index, and returning one tiny document rather than one
    // 200 KB one.
    expect(winningStages(plan)).not.toContain('COLLSCAN');
  });

  it('finds an image by its id through an index, never a scan', async () => {
    const repository = createMongoImageRepository(db);
    await repository.save(image());

    const plan = await db
      .collection(MEDIA_COLLECTION)
      .find({ _id: 'a'.repeat(64), storeId: 'taz4tech' } as never)
      .explain('executionStats');

    expect(usesIndex(winningStages(plan))).toBe(true);
  });

  it('throws rather than serving a document that is not an image any more', async () => {
    // Untrusted input, like every other document read in this codebase: a
    // content type nobody accepts today must not reach a browser because it was
    // written by an older version of the code.
    await db.collection(MEDIA_COLLECTION).insertOne({
      _id: 'c'.repeat(64),
      storeId: 'taz4tech',
      contentType: 'image/svg+xml',
      bytes: new Uint8Array([1]),
      storedAt: new Date(),
    } as never);

    const repository = createMongoImageRepository(db);
    await expect(repository.findById('taz4tech', 'c'.repeat(64))).rejects.toThrow(/malformed/);
  });
});
