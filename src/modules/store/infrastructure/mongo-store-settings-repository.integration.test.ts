import { sameEverywhere } from '@platform/regions';
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
  deliveryFees: sameEverywhere(0),
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

  it('reads a document written before delivery was priced per governorate', async () => {
    /*
     * The migration, and the reason it is a read rather than a script.
     *
     * A document from before this change carries `deliveryFeeCents: 250` and no
     * table. That number meant "this much, everywhere" — so that is exactly what
     * it becomes, for all eight. A store that stopped booting because a field it
     * never had is missing would be a migration disguised as a schema.
     */
    await db.collection(STORE_SETTINGS_COLLECTION).insertOne({
      storeId: 'taz4tech',
      name: 'Taz4Tech',
      defaultLocale: 'en',
      locales: ['en', 'ar', 'fr'],
      siteUrl: 'https://taz4tech.com',
      contactPhone: '+96170123456',
      vatBasisPoints: 1100,
      commercialRegistryNumber: null,
      deliveryFeeCents: 250,
    });

    const found = await createMongoStoreSettingsRepository(db).findByStoreId('taz4tech');
    expect(found?.deliveryFees).toEqual(sameEverywhere(250));
  });

  it('fills a governorate the table forgot from the old flat fee, not from zero', async () => {
    // An absent price is a price nobody set. Reading it as free would quietly
    // give away every delivery to that governorate.
    await db.collection(STORE_SETTINGS_COLLECTION).insertOne({
      storeId: 'taz4tech',
      name: 'Taz4Tech',
      defaultLocale: 'en',
      locales: ['en', 'ar', 'fr'],
      siteUrl: 'https://taz4tech.com',
      contactPhone: '+96170123456',
      vatBasisPoints: 1100,
      commercialRegistryNumber: null,
      deliveryFeeCents: 250,
      deliveryFees: { beirut: 100 },
    });

    const found = await createMongoStoreSettingsRepository(db).findByStoreId('taz4tech');
    expect(found?.deliveryFees.beirut).toBe(100);
    expect(found?.deliveryFees.akkar).toBe(250);
  });

  it('drops the superseded flat fee when settings are saved', async () => {
    // Leaving it behind would be a second, stale answer to what delivery costs,
    // sitting in the document looking authoritative.
    const collection = db.collection(STORE_SETTINGS_COLLECTION);
    await collection.insertOne({ storeId: 'taz4tech', deliveryFeeCents: 250 });

    await createMongoStoreSettingsRepository(db).save(
      settings({ deliveryFees: sameEverywhere(400) }),
    );

    const raw = await collection.findOne({ storeId: 'taz4tech' });
    expect(raw).not.toHaveProperty('deliveryFeeCents');
    expect(raw?.deliveryFees).toEqual(sameEverywhere(400));
  });

  it('round-trips a table with a different price per governorate', async () => {
    const repository = createMongoStoreSettingsRepository(db);
    const fees = { ...sameEverywhere(300), beirut: 0, akkar: 1250 };
    await repository.save(settings({ deliveryFees: fees }));

    expect((await repository.findByStoreId('taz4tech'))?.deliveryFees).toEqual(fees);
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
