import { type Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scansCollection, usesIndex, winningStages } from '@/test-support/explain';
import type { StockLevel } from '../domain/stock';
import {
  createMongoStockRepository,
  ensureStockIndexes,
  STOCK_COLLECTION,
  stockId,
} from './mongo-stock-repository';

const URI = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_TEST_DB ?? 'taz4tech_test';

let client: MongoClient;
let db: Db;

const NOW = new Date('2026-08-27T10:00:00Z');
const LATER = new Date('2026-08-27T11:00:00Z');

const level = (overrides: Partial<StockLevel> = {}): StockLevel => ({
  storeId: 'taz4tech',
  sku: 'SKU-1',
  policy: 'tracked',
  onHand: 5,
  updatedAt: NOW,
  ...overrides,
});

beforeAll(async () => {
  client = await MongoClient.connect(URI);
  db = client.db(DB_NAME);
});

afterAll(async () => {
  await db
    .collection(STOCK_COLLECTION)
    .drop()
    .catch(() => undefined);
  await client.close();
});

beforeEach(async () => {
  await db.collection(STOCK_COLLECTION).deleteMany({});
  await ensureStockIndexes(db);
});

describe('stockId', () => {
  it('cannot be read two ways', () => {
    /*
     * The reason it is length-prefixed. With a plain `storeId:sku` join, store
     * "a" holding SKU "b:c" and store "a:b" holding SKU "c" produce the same
     * key — one tenant's stock silently becoming another's. SKUs come from other
     * people's spreadsheets; they contain anything.
     */
    expect(stockId('a', 'b:c')).not.toBe(stockId('a:b', 'c'));
  });
});

describe('save and read', () => {
  it('round-trips a level', async () => {
    const repository = createMongoStockRepository(db);
    await repository.save(level({ onHand: 7 }));

    expect(await repository.findBySku('taz4tech', 'SKU-1')).toEqual(level({ onHand: 7 }));
  });

  it('returns null for a SKU with no record', async () => {
    // Absent, not zero — the domain reads that as untracked.
    expect(await createMongoStockRepository(db).findBySku('taz4tech', 'NOPE')).toBeNull();
  });

  it('overwrites rather than duplicating', async () => {
    const repository = createMongoStockRepository(db);
    await repository.save(level({ onHand: 5 }));
    await repository.save(level({ onHand: 2, updatedAt: LATER }));

    expect(await db.collection(STOCK_COLLECTION).countDocuments({})).toBe(1);
    expect((await repository.findBySku('taz4tech', 'SKU-1'))?.onHand).toBe(2);
  });

  it('never crosses tenants', async () => {
    const repository = createMongoStockRepository(db);
    await repository.save(level({ storeId: 'tenant-a' }));

    expect(await repository.findBySku('tenant-b', 'SKU-1')).toBeNull();
  });

  it('keeps two tenants holding the same SKU apart', async () => {
    const repository = createMongoStockRepository(db);
    await repository.save(level({ storeId: 'tenant-a', onHand: 1 }));
    await repository.save(level({ storeId: 'tenant-b', onHand: 9 }));

    expect((await repository.findBySku('tenant-a', 'SKU-1'))?.onHand).toBe(1);
    expect((await repository.findBySku('tenant-b', 'SKU-1'))?.onHand).toBe(9);
  });

  it('refuses to hand back a document it cannot read', async () => {
    // A document written by an older version, or by a hand-run command during
    // an incident, is exactly what turns into a NaN quantity three layers up.
    await db.collection(STOCK_COLLECTION).insertOne({
      _id: stockId('taz4tech', 'BAD') as never,
      storeId: 'taz4tech',
      sku: 'BAD',
      policy: 'tracked',
      onHand: -4,
      updatedAt: NOW,
    });

    await expect(createMongoStockRepository(db).findBySku('taz4tech', 'BAD')).rejects.toThrow(
      /Unreadable stock document/,
    );
  });
});

describe('findBySkus', () => {
  it('returns every match in one query', async () => {
    const repository = createMongoStockRepository(db);
    await repository.save(level({ sku: 'A' }));
    await repository.save(level({ sku: 'B' }));

    const found = await repository.findBySkus('taz4tech', ['A', 'C']);
    expect(found.map((entry) => entry.sku)).toEqual(['A']);
  });

  it('returns nothing for an empty list without querying', async () => {
    expect(await createMongoStockRepository(db).findBySkus('taz4tech', [])).toEqual([]);
  });

  it('never crosses tenants', async () => {
    const repository = createMongoStockRepository(db);
    await repository.save(level({ storeId: 'tenant-a', sku: 'A' }));

    expect(await repository.findBySkus('tenant-b', ['A'])).toEqual([]);
  });

  it('reads by primary key rather than scanning', async () => {
    const repository = createMongoStockRepository(db);
    await repository.save(level({ sku: 'A' }));

    const explain = await db
      .collection<{ _id: string; storeId: string }>(STOCK_COLLECTION)
      .find({ _id: { $in: [stockId('taz4tech', 'A')] }, storeId: 'taz4tech' })
      .explain();
    const stages = winningStages(explain);

    expect(scansCollection(stages), stages.join(', ')).toBe(false);
    expect(usesIndex(stages), stages.join(', ')).toBe(true);
  });
});

describe('adjust', () => {
  it('decrements and returns the new level', async () => {
    const repository = createMongoStockRepository(db);
    await repository.save(level({ onHand: 5 }));

    const result = await repository.adjust('taz4tech', 'SKU-1', -2, LATER);
    expect(result).toEqual({ ok: true, value: level({ onHand: 3, updatedAt: LATER }) });
  });

  it('increments, which is how a cancelled order gives stock back', async () => {
    const repository = createMongoStockRepository(db);
    await repository.save(level({ onHand: 5 }));

    expect((await repository.adjust('taz4tech', 'SKU-1', 3, LATER)).ok).toBe(true);
    expect((await repository.findBySku('taz4tech', 'SKU-1'))?.onHand).toBe(8);
  });

  it('takes the last unit', async () => {
    const repository = createMongoStockRepository(db);
    await repository.save(level({ onHand: 1 }));

    expect((await repository.adjust('taz4tech', 'SKU-1', -1, LATER)).ok).toBe(true);
    expect((await repository.findBySku('taz4tech', 'SKU-1'))?.onHand).toBe(0);
  });

  it('refuses to go below zero, and says what is there', async () => {
    const repository = createMongoStockRepository(db);
    await repository.save(level({ onHand: 2 }));

    expect(await repository.adjust('taz4tech', 'SKU-1', -3, LATER)).toEqual({
      ok: false,
      error: { tag: 'insufficient', sku: 'SKU-1', onHand: 2 },
    });
    expect((await repository.findBySku('taz4tech', 'SKU-1'))?.onHand).toBe(2);
  });

  it('reports untracked for a SKU with no record', async () => {
    expect(await createMongoStockRepository(db).adjust('taz4tech', 'NOPE', -1, LATER)).toEqual({
      ok: false,
      error: { tag: 'untracked', sku: 'NOPE' },
    });
  });

  it('reports untracked for a SKU deliberately not counted', async () => {
    // Distinct from insufficient on purpose: untracked sells freely, exhausted
    // must not. A sale reads one as success and the other as a refusal.
    const repository = createMongoStockRepository(db);
    await repository.save(level({ policy: 'untracked', onHand: 0 }));

    expect(await repository.adjust('taz4tech', 'SKU-1', -1, LATER)).toEqual({
      ok: false,
      error: { tag: 'untracked', sku: 'SKU-1' },
    });
  });

  it('never crosses tenants', async () => {
    const repository = createMongoStockRepository(db);
    await repository.save(level({ storeId: 'tenant-a', onHand: 5 }));

    expect((await repository.adjust('tenant-b', 'SKU-1', -1, LATER)).ok).toBe(false);
    expect((await repository.findBySku('tenant-a', 'SKU-1'))?.onHand).toBe(5);
  });

  describe('under concurrency', () => {
    /*
     * The reason stock is its own document, tested against a real database
     * rather than argued about in a comment.
     *
     * A mock cannot show this: the failure being prevented is two processes
     * interleaving between a read and a write, and a fake repository has no
     * interleaving to expose.
     */
    it('cannot sell the last unit twice', async () => {
      const repository = createMongoStockRepository(db);
      await repository.save(level({ onHand: 1 }));

      const both = await Promise.all([
        repository.adjust('taz4tech', 'SKU-1', -1, LATER),
        repository.adjust('taz4tech', 'SKU-1', -1, LATER),
      ]);

      expect(both.filter((result) => result.ok)).toHaveLength(1);
      expect(both.filter((result) => !result.ok)).toHaveLength(1);
      expect((await repository.findBySku('taz4tech', 'SKU-1'))?.onHand).toBe(0);
    });

    it('lets exactly as many buyers through as there are units', async () => {
      const repository = createMongoStockRepository(db);
      await repository.save(level({ onHand: 10 }));

      const attempts = await Promise.all(
        Array.from({ length: 25 }, () => repository.adjust('taz4tech', 'SKU-1', -1, LATER)),
      );

      expect(attempts.filter((result) => result.ok)).toHaveLength(10);
      expect((await repository.findBySku('taz4tech', 'SKU-1'))?.onHand).toBe(0);
    });

    it('never lets the count go negative under a mixed load', async () => {
      // Decrements of two against an odd starting count: the interesting case
      // is the attempt that finds exactly one unit left.
      const repository = createMongoStockRepository(db);
      await repository.save(level({ onHand: 9 }));

      await Promise.all(
        Array.from({ length: 20 }, () => repository.adjust('taz4tech', 'SKU-1', -2, LATER)),
      );

      const remaining = (await repository.findBySku('taz4tech', 'SKU-1'))?.onHand ?? -1;
      expect(remaining).toBe(1);
    });
  });
});

describe('indexes', () => {
  it('creates the admin index and no redundant one on the natural key', async () => {
    // (storeId, sku) IS the _id, so a second index over it would be dead weight
    // paid for on every write.
    const names = (await db.collection(STOCK_COLLECTION).indexes()).map((index) => index.name);
    expect(names).toContain('storeId_policy_onHand');
    expect(names).toEqual(expect.arrayContaining(['_id_']));
    expect(names).toHaveLength(2);
  });

  it('is safe to run twice', async () => {
    await expect(ensureStockIndexes(db)).resolves.toBeUndefined();
  });
});
