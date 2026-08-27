import { type Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scansCollection, usesIndex, winningStages } from '@/test-support/explain';
import type { StoreSettings } from '../domain/store-settings';
import {
  createMongoStoreSettingsRepository,
  ensureStoreIndexes,
  STORE_SETTINGS_COLLECTION,
} from './mongo-store-settings-repository';

const URI = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_TEST_DB ?? 'taz4tech_test';

let client: MongoClient;
let db: Db;

const settings = (overrides: Partial<StoreSettings> = {}): StoreSettings => ({
  storeId: 'taz4tech',
  name: 'Taz4Tech',
  defaultLocale: 'en',
  locales: ['en', 'ar', 'fr'],
  siteUrl: 'https://taz4tech.com',
  contactPhone: '+96170123456',
  vatBasisPoints: 1100,
  commercialRegistryNumber: null,
  deliveryFeeCents: 0,
  ...overrides,
});

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
    .collection(STORE_SETTINGS_COLLECTION)
    .drop()
    .catch(() => undefined);
  await ensureStoreIndexes(db);
});

describe('MongoStoreSettingsRepository', () => {
  it('round-trips a settings document', async () => {
    const repository = createMongoStoreSettingsRepository(db);
    await repository.save(settings());

    const found = await repository.findByStoreId('taz4tech');
    expect(found).toEqual(settings());
  });

  it('returns null for a store that has not been seeded', async () => {
    const repository = createMongoStoreSettingsRepository(db);
    expect(await repository.findByStoreId('nobody')).toBeNull();
  });

  it('never returns another tenant’s document', async () => {
    const repository = createMongoStoreSettingsRepository(db);
    await repository.save(settings({ storeId: 'tenant-a', name: 'Store A' }));
    await repository.save(settings({ storeId: 'tenant-b', name: 'Store B' }));

    expect((await repository.findByStoreId('tenant-a'))?.name).toBe('Store A');
    expect((await repository.findByStoreId('tenant-b'))?.name).toBe('Store B');
  });

  it('upserts rather than duplicating on a second save', async () => {
    const repository = createMongoStoreSettingsRepository(db);
    await repository.save(settings());
    await repository.save(settings({ name: 'Taz4Tech Renamed' }));

    const count = await db
      .collection(STORE_SETTINGS_COLLECTION)
      .countDocuments({ storeId: 'taz4tech' });
    expect(count).toBe(1);
    expect((await repository.findByStoreId('taz4tech'))?.name).toBe('Taz4Tech Renamed');
  });

  it('enforces one settings document per tenant at the database level', async () => {
    await db.collection(STORE_SETTINGS_COLLECTION).insertOne(settings());
    await expect(db.collection(STORE_SETTINGS_COLLECTION).insertOne(settings())).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it('creates its index idempotently', async () => {
    await ensureStoreIndexes(db);
    await ensureStoreIndexes(db);

    const indexes = await db.collection(STORE_SETTINGS_COLLECTION).indexes();
    expect(indexes.filter((i) => i.name === 'storeId_unique')).toHaveLength(1);
  });

  it('uses an index scan, never a collection scan', async () => {
    const repository = createMongoStoreSettingsRepository(db);
    await repository.save(settings());

    const explained = await db
      .collection(STORE_SETTINGS_COLLECTION)
      .find({ storeId: 'taz4tech' })
      .explain('queryPlanner');

    const stages = winningStages(explained);

    // Guard against the walker silently returning nothing: an empty list would
    // satisfy the COLLSCAN assertion below without proving anything at all.
    expect(stages, 'explain plan yielded no stages — the walker is broken').not.toEqual([]);

    // The whole point of the gate: a query that works but scans the collection
    // is fine at ten documents and fatal at ten thousand.
    expect(scansCollection(stages), `plan stages: ${stages.join(', ')}`).toBe(false);

    // Matched as a substring rather than equality: MongoDB 8 serves a
    // single-field equality on an indexed field with EXPRESS_IXSCAN, a fast path
    // that is better than a plain IXSCAN, not worse. Asserting the exact string
    // would fail on a correctly-indexed query.
    expect(usesIndex(stages), `expected an index scan, got: ${stages.join(', ')}`).toBe(true);
  });

  it('the COLLSCAN detector actually detects a collection scan', async () => {
    // Negative control. Without this, a walker that returned the wrong shape
    // would make every COLLSCAN assertion pass vacuously, and the gate that is
    // supposed to keep unindexed queries out of production would be decorative.
    const repository = createMongoStoreSettingsRepository(db);
    await repository.save(settings());

    const explained = await db
      .collection(STORE_SETTINGS_COLLECTION)
      .find({ name: 'Taz4Tech' }) // deliberately unindexed field
      .explain('queryPlanner');

    const stages = winningStages(explained);
    expect(stages).toContain('COLLSCAN');
  });

  it('rejects a malformed stored document instead of rendering undefined', async () => {
    // Simulates a document written by an older version of the code. Casting
    // rather than parsing would let the missing field reach the page.
    await db
      .collection(STORE_SETTINGS_COLLECTION)
      .insertOne({ storeId: 'taz4tech', name: 'Broken' } as never);

    const repository = createMongoStoreSettingsRepository(db);
    await expect(repository.findByStoreId('taz4tech')).rejects.toThrow(/malformed/);
  });

  it('rejects a stored document that violates a domain invariant', async () => {
    await db
      .collection(STORE_SETTINGS_COLLECTION)
      .insertOne(settings({ contactPhone: '70123456' }) as never);

    const repository = createMongoStoreSettingsRepository(db);
    await expect(repository.findByStoreId('taz4tech')).rejects.toThrow(/invariant/);
  });
});
