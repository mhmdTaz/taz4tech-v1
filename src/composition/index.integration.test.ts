import { resetConfig } from '@platform/config';
import { type Db, MongoClient } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildContainer, resetContainer } from './index';

/**
 * Building the container must leave the database ready to be used.
 *
 * This exists because it did not, and the gap was invisible. Indexes were
 * created only by the seed scripts, so a database the app reached first — a new
 * Atlas cluster, a preview environment, a developer's fresh container — ran
 * without them. `$text` search threw 500s, and, far worse, the UNIQUE indexes on
 * slug and SKU were absent, so two products could hold one SKU and nothing
 * anywhere would say so.
 *
 * Asserting on the indexes rather than on "ensureIndexes was called" is the
 * point: a spy would pass just as happily if the method it called did nothing.
 */

const URI = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = `${process.env.MONGODB_TEST_DB ?? 'taz4tech_test'}_boot`;

let client: MongoClient;
let db: Db;

beforeAll(async () => {
  client = await MongoClient.connect(URI);
  db = client.db(DB_NAME);
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

beforeEach(async () => {
  // A genuinely empty database, which is the state that exposed the bug.
  await db.dropDatabase();
  resetContainer();
  resetConfig();
  process.env.MONGODB_URI = URI;
  process.env.MONGODB_DB = DB_NAME;
  process.env.STORE_ID = 'taz4tech';
});

afterEach(async () => {
  resetContainer();
  resetConfig();
});

const indexNames = async (collection: string): Promise<string[]> =>
  (await db.collection(collection).indexes()).map((index) => String(index.name)).sort();

describe('buildContainer', () => {
  it('creates the unique index on slug', async () => {
    await buildContainer();
    expect(await indexNames('products')).toContain('storeId_slug_unique');
  });

  it('creates the unique index on variant SKU', async () => {
    // The one the importer's create-vs-update decision and the bulk editor's
    // conflict reporting are both built on.
    await buildContainer();
    expect(await indexNames('products')).toContain('storeId_sku_unique');
  });

  it('creates a text index, without which search is a 500 rather than empty', async () => {
    await buildContainer();
    const indexes = await db.collection('products').indexes();
    expect(indexes.some((index) => Object.values(index.key ?? {}).includes('text'))).toBe(true);
  });

  it('creates the collection indexes too', async () => {
    await buildContainer();
    expect(await indexNames('collections')).toContain('storeId_slug_unique');
  });

  it('actually enforces the SKU constraint afterwards', async () => {
    // The end the indexes are a means to. Without this the test above could pass
    // against an index created with the wrong options.
    const container = await buildContainer();
    const products = container.db.collection('products');

    await products.insertOne({
      _id: 'A' as never,
      storeId: 'taz4tech',
      slug: 'a',
      variants: [{ sku: 'DUP' }],
    });
    await expect(
      products.insertOne({
        _id: 'B' as never,
        storeId: 'taz4tech',
        slug: 'b',
        variants: [{ sku: 'DUP' }],
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('is safe to run again against a database that already has them', async () => {
    // Every cold start runs this. createIndex is idempotent, and if it were not,
    // the second boot of any deploy would fail.
    await buildContainer();
    resetContainer();
    await expect(buildContainer()).resolves.toBeDefined();
  });
});
