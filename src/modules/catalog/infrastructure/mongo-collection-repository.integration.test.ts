import { englishOnly } from '@platform/locale';
import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { type Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scansCollection, usesIndex, winningStages } from '@/test-support/explain';
import type { CollectionRepository, ProductRepository } from '../contracts';
import type { Collection, CollectionId } from '../domain/collection';
import type { Product, ProductId, Variant } from '../domain/product';
import {
  COLLECTIONS_COLLECTION,
  createMongoCollectionRepository,
  ensureCollectionIndexes,
} from './mongo-collection-repository';
import {
  createMongoProductRepository,
  ensureProductIndexes,
  PRODUCTS_COLLECTION,
} from './mongo-product-repository';

const URI = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_TEST_DB ?? 'taz4tech_test';

let client: MongoClient;
let db: Db;
let collections: CollectionRepository;
let products: ProductRepository;

const usd = (cents: number) => unwrapOrThrow(fromCents(cents));
const NOW = new Date('2026-08-01T10:00:00Z');
const pid = (n: number): ProductId => `PRODUCT${String(n).padStart(19, '0')}` as ProductId;
const cid = (n: number): CollectionId => `COLLECT${String(n).padStart(19, '0')}` as CollectionId;

const variant = (sku: string, cents: number, options: Variant['options'] = []): Variant => ({
  sku,
  options,
  price: usd(cents),
  compareAtPrice: null,
  offerEndsAt: null,
  barcode: null,
  weightGrams: null,
});

const product = (n: number, overrides: Partial<Product> = {}): Product => ({
  storeId: 'taz4tech',
  id: pid(n),
  slug: `product-${n}`,
  title: englishOnly(`Product ${n}`),
  description: englishOnly('A thing.'),
  brand: null,
  status: 'active',
  optionNames: [],
  variants: [variant(`SKU-${n}`, 1000 * n)],
  media: [],
  specs: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const collection = (n: number, overrides: Partial<Collection> = {}): Collection => ({
  storeId: 'taz4tech',
  id: cid(n),
  slug: `collection-${n}`,
  title: englishOnly(`Collection ${n}`),
  description: englishOnly('A grouping.'),
  status: 'active',
  rules: { brands: ['Lenovo'] },
  pinnedProductIds: [],
  sort: 'newest',
  position: n,
  createdAt: NOW,
  updatedAt: NOW,
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
  for (const name of [COLLECTIONS_COLLECTION, PRODUCTS_COLLECTION]) {
    await db
      .collection(name)
      .drop()
      .catch(() => undefined);
  }
  await ensureCollectionIndexes(db);
  await ensureProductIndexes(db);
  collections = createMongoCollectionRepository(db);
  products = createMongoProductRepository(db);
});

describe('MongoCollectionRepository', () => {
  it('round-trips a collection exactly', async () => {
    const original = collection(1, {
      rules: {
        brands: ['Lenovo', 'Dell'],
        options: [{ name: 'Colour', values: ['Black'] }],
        priceMinCents: 1000,
        priceMaxCents: 90000,
      },
      pinnedProductIds: [pid(7), pid(8)],
      sort: 'price-asc',
      title: { en: 'Laptops', ar: 'حواسيب محمولة' },
    });

    await collections.save(original);
    expect(await collections.findBySlug('taz4tech', 'collection-1')).toEqual(original);
  });

  it('omits an absent locale rather than storing undefined', async () => {
    await collections.save(collection(1, { title: { en: 'Laptops', ar: 'حواسيب' } }));
    const found = await collections.findBySlug('taz4tech', 'collection-1');
    expect(Object.hasOwn(found?.title ?? {}, 'fr')).toBe(false);
  });

  it('never returns another tenant’s collection', async () => {
    await collections.save(collection(1, { storeId: 'tenant-a' }));
    expect(await collections.findBySlug('tenant-b', 'collection-1')).toBeNull();
  });

  it('finds by id, scoped to the tenant', async () => {
    await collections.save(collection(3));
    expect((await collections.findById('taz4tech', cid(3)))?.slug).toBe('collection-3');
    expect(await collections.findById('other', cid(3))).toBeNull();
  });

  it('rejects two collections sharing a slug in one store', async () => {
    await collections.save(collection(1, { slug: 'laptops' }));
    await expect(collections.save(collection(2, { slug: 'laptops' }))).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it('upserts rather than duplicating', async () => {
    await collections.save(collection(1));
    await collections.save(collection(1, { title: englishOnly('Renamed') }));
    expect(await db.collection(COLLECTIONS_COLLECTION).countDocuments({})).toBe(1);
  });

  describe('listing', () => {
    it('returns collections in navigation order', async () => {
      await collections.save(collection(3, { position: 2 }));
      await collections.save(collection(1, { position: 0 }));
      await collections.save(collection(2, { position: 1 }));

      const listed = await collections.list({ storeId: 'taz4tech' });
      expect(listed.map((c) => c.slug)).toEqual(['collection-1', 'collection-2', 'collection-3']);
    });

    it('breaks a position tie by title, so navigation is stable', async () => {
      await collections.save(collection(1, { position: 0, title: englishOnly('Zebra') }));
      await collections.save(collection(2, { position: 0, title: englishOnly('Apple') }));

      const listed = await collections.list({ storeId: 'taz4tech' });
      expect(listed.map((c) => c.title.en)).toEqual(['Apple', 'Zebra']);
    });

    it('filters by status', async () => {
      await collections.save(collection(1, { status: 'active' }));
      await collections.save(collection(2, { status: 'draft' }));

      expect(await collections.list({ storeId: 'taz4tech', status: 'active' })).toHaveLength(1);
      expect(await collections.list({ storeId: 'taz4tech' })).toHaveLength(2);
    });

    it('serves the navigation query from an index', async () => {
      await collections.save(collection(1));
      const explained = await db
        .collection(COLLECTIONS_COLLECTION)
        .find({ storeId: 'taz4tech', status: 'active' })
        .sort({ position: 1 })
        .explain('queryPlanner');

      const stages = winningStages(explained);
      expect(scansCollection(stages), stages.join(', ')).toBe(false);
      expect(usesIndex(stages), stages.join(', ')).toBe(true);
    });
  });

  it('rejects a stored document that violates a domain invariant', async () => {
    await collections.save(collection(1));
    // Reach past the repository to write something the domain forbids: no rules
    // and no pinned products can never contain anything.
    await db
      .collection(COLLECTIONS_COLLECTION)
      .updateOne({ _id: cid(1) } as never, { $set: { rules: {}, pinnedProductIds: [] } });

    await expect(collections.findById('taz4tech', cid(1))).rejects.toThrow(/invariant/);
  });
});

describe('collection membership in search', () => {
  beforeEach(async () => {
    await products.save(product(1, { brand: 'Lenovo', variants: [variant('A', 10000)] }));
    await products.save(product(2, { brand: 'Lenovo', variants: [variant('B', 50000)] }));
    await products.save(product(3, { brand: 'Dell', variants: [variant('C', 30000)] }));
    await products.save(product(4, { brand: 'Anker', variants: [variant('D', 2000)] }));
  });

  const inCollection = (
    membership: { rules: Record<string, unknown>; pinnedProductIds: ProductId[] },
    filters: Record<string, unknown> = {},
  ) =>
    products.search({
      storeId: 'taz4tech',
      status: 'active',
      limit: 24,
      membership: membership as never,
      filters: filters as never,
    });

  it('selects by the collection rules', async () => {
    const result = await inCollection({ rules: { brands: ['Lenovo'] }, pinnedProductIds: [] });
    expect(result.products.map((p) => p.slug).sort()).toEqual(['product-1', 'product-2']);
  });

  it('includes pinned products that the rules would exclude', async () => {
    // The whole point of pinning: the one accessory that belongs in "Gaming"
    // without matching any rule.
    const result = await inCollection({
      rules: { brands: ['Lenovo'] },
      pinnedProductIds: [pid(4)],
    });
    expect(result.products.map((p) => p.slug).sort()).toEqual([
      'product-1',
      'product-2',
      'product-4',
    ]);
  });

  it('supports a fully curated collection with no rules at all', async () => {
    const result = await inCollection({ rules: {}, pinnedProductIds: [pid(3), pid(4)] });
    expect(result.products.map((p) => p.slug).sort()).toEqual(['product-3', 'product-4']);
  });

  it('does NOT let a pinned product survive a customer filter it fails', async () => {
    // The nesting that matters: membership is ORed, the customer's filter is
    // ANDed on top. Get it backwards and a pinned Anker shows up under
    // "Lenovo only".
    const result = await inCollection(
      { rules: { brands: ['Lenovo'] }, pinnedProductIds: [pid(4)] },
      { brands: ['Lenovo'] },
    );
    expect(result.products.map((p) => p.slug).sort()).toEqual(['product-1', 'product-2']);
  });

  it('narrows a collection by a customer price filter', async () => {
    const result = await inCollection(
      { rules: { brands: ['Lenovo'] }, pinnedProductIds: [] },
      { priceMinCents: 40000 },
    );
    expect(result.products.map((p) => p.slug)).toEqual(['product-2']);
  });

  it('counts facets within the collection, not across the catalogue', async () => {
    // A facet fragment would let "Laptops" report brand counts drawn from the
    // whole shop, offering the customer a filter that returns nothing.
    const result = await inCollection({
      rules: { brands: ['Lenovo'] },
      pinnedProductIds: [pid(3)],
    });
    expect(result.facets.brands.map((b) => b.value).sort()).toEqual(['Dell', 'Lenovo']);
    expect(result.facets.brands.find((b) => b.value === 'Anker')).toBeUndefined();
  });

  it('reports the price range within the collection only', async () => {
    const result = await inCollection({ rules: { brands: ['Lenovo'] }, pinnedProductIds: [] });
    expect(result.facets.priceRange).toEqual({ minCents: 10000, maxCents: 50000 });
  });

  it('returns nothing for a membership that selects nothing', async () => {
    // The domain forbids this shape; the repository must not fall back to
    // matching the entire catalogue if one ever reaches it.
    const result = await inCollection({ rules: {}, pinnedProductIds: [] });
    expect(result.products).toEqual([]);
  });

  it('still excludes drafts inside a collection', async () => {
    await products.save(product(9, { brand: 'Lenovo', status: 'draft' }));
    const result = await inCollection({ rules: { brands: ['Lenovo'] }, pinnedProductIds: [] });
    expect(result.products.map((p) => p.slug)).not.toContain('product-9');
  });

  it('excludes a draft even when it is explicitly pinned', async () => {
    // Pinning is curation, not publication. An unpublished product must stay
    // unpublished however deliberately it was added to a collection.
    await products.save(product(9, { brand: 'Ghost', status: 'draft' }));
    const result = await inCollection({ rules: {}, pinnedProductIds: [pid(9)] });
    expect(result.products).toEqual([]);
  });
});
