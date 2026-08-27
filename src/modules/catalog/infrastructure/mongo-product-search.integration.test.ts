import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { type Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scansCollection, usesIndex, winningStages } from '@/test-support/explain';
import type { ProductFilters, ProductRepository } from '../contracts';
import type { Product, ProductId, Variant } from '../domain/product';
import {
  createMongoProductRepository,
  ensureProductIndexes,
  PRODUCTS_COLLECTION,
} from './mongo-product-repository';

const URI = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_TEST_DB ?? 'taz4tech_test';

let client: MongoClient;
let db: Db;
let repository: ProductRepository;

const usd = (cents: number) => unwrapOrThrow(fromCents(cents));
const CREATED = new Date('2026-08-01T10:00:00Z');
const id = (n: number): ProductId => `PRODUCT${String(n).padStart(19, '0')}` as ProductId;

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
  id: id(n),
  slug: `product-${n}`,
  title: { en: `Product ${n}` },
  description: { en: 'A thing.' },
  brand: null,
  status: 'active',
  optionNames: [],
  variants: [variant(`SKU-${n}`, 1000 * n)],
  media: [],
  specs: [],
  createdAt: CREATED,
  updatedAt: CREATED,
  ...overrides,
});

const search = (filters: ProductFilters = {}, limit = 24) =>
  repository.search({ storeId: 'taz4tech', status: 'active', limit, filters });

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
    .collection(PRODUCTS_COLLECTION)
    .drop()
    .catch(() => undefined);
  await ensureProductIndexes(db);
  repository = createMongoProductRepository(db);
});

describe('search', () => {
  beforeEach(async () => {
    await repository.save(
      product(1, {
        slug: 'lenovo-laptop',
        title: { en: 'Lenovo Laptop', ar: 'لابتوب لينوفو' },
        brand: 'Lenovo',
        optionNames: ['Colour'],
        variants: [
          variant('L-BLK', 119900, [{ name: 'Colour', value: 'Black' }]),
          variant('L-SLV', 139900, [{ name: 'Colour', value: 'Silver' }]),
        ],
      }),
    );
    await repository.save(
      product(2, {
        slug: 'dell-monitor',
        title: { en: 'Dell Monitor', ar: 'شاشة ديل' },
        brand: 'Dell',
        optionNames: ['Colour'],
        variants: [variant('D-BLK', 29900, [{ name: 'Colour', value: 'Black' }])],
      }),
    );
    await repository.save(
      product(3, { slug: 'anker-cable', title: { en: 'Anker Cable' }, brand: 'Anker' }),
    );
    await repository.save(
      product(4, { slug: 'hidden-draft', title: { en: 'Hidden Laptop' }, status: 'draft' }),
    );
  });

  it('finds a product by a word in its title', async () => {
    const result = await search({ search: 'lenovo' });
    expect(result.products.map((p) => p.slug)).toEqual(['lenovo-laptop']);
  });

  it('finds an English product from an Arabic search', async () => {
    // The whole point of synonym expansion: the catalogue is in English and a
    // large share of customers search in Arabic.
    const result = await search({ search: 'لابتوب' });
    expect(result.products.map((p) => p.slug)).toContain('lenovo-laptop');
  });

  it('finds an Arabic title from an English search', async () => {
    const result = await search({ search: 'monitor' });
    expect(result.products.map((p) => p.slug)).toContain('dell-monitor');
  });

  it('matches despite Arabic spelling variation', async () => {
    // شاشه (ta marbuta folded) must find شاشة.
    const result = await search({ search: 'شاشه' });
    expect(result.products.map((p) => p.slug)).toContain('dell-monitor');
  });

  it('finds a product by its SKU', async () => {
    const result = await search({ search: 'L-SLV' });
    expect(result.products.map((p) => p.slug)).toEqual(['lenovo-laptop']);
  });

  it('never returns a draft, however well it matches', async () => {
    const result = await search({ search: 'laptop' });
    expect(result.products.map((p) => p.slug)).not.toContain('hidden-draft');
  });

  it('returns nothing for a term that matches nothing', async () => {
    const result = await search({ search: 'zzzznothing' });
    expect(result.products).toEqual([]);
  });

  it('returns everything when no search is given', async () => {
    const result = await search({});
    expect(result.products).toHaveLength(3);
  });
});

describe('filters', () => {
  beforeEach(async () => {
    await repository.save(product(1, { brand: 'Lenovo', variants: [variant('A', 10000)] }));
    await repository.save(product(2, { brand: 'Lenovo', variants: [variant('B', 50000)] }));
    await repository.save(product(3, { brand: 'Dell', variants: [variant('C', 30000)] }));
    await repository.save(
      product(4, {
        brand: 'Dell',
        optionNames: ['Colour'],
        variants: [
          variant('D1', 20000, [{ name: 'Colour', value: 'Black' }]),
          variant('D2', 90000, [{ name: 'Colour', value: 'Silver' }]),
        ],
      }),
    );
  });

  it('filters by brand', async () => {
    const result = await search({ brands: ['Lenovo'] });
    expect(result.products).toHaveLength(2);
  });

  it('treats several brands as OR', async () => {
    const result = await search({ brands: ['Lenovo', 'Dell'] });
    expect(result.products).toHaveLength(4);
  });

  it('filters by option value', async () => {
    const result = await search({ options: [{ name: 'Colour', values: ['Silver'] }] });
    expect(result.products.map((p) => p.slug)).toEqual(['product-4']);
  });

  it('filters by price range', async () => {
    const result = await search({ priceMinCents: 25000, priceMaxCents: 60000 });
    expect(result.products.map((p) => p.slug).sort()).toEqual(['product-2', 'product-3']);
  });

  it('requires ONE variant to satisfy both price bounds', async () => {
    // product-4 has a $200 and a $900 variant and NOTHING between. A naive
    // filter matches it here anyway, because one variant clears the lower bound
    // and a different one clears the upper — showing the customer a product
    // with nothing in the range they asked for.
    const result = await search({ priceMinCents: 25000, priceMaxCents: 85000 });
    const slugs = result.products.map((p) => p.slug);

    expect(slugs).not.toContain('product-4');
    // The products that genuinely have a variant in range are still returned.
    expect(slugs.sort()).toEqual(['product-2', 'product-3']);
  });

  it('combines filters as AND', async () => {
    const result = await search({ brands: ['Dell'], priceMinCents: 25000, priceMaxCents: 35000 });
    expect(result.products.map((p) => p.slug)).toEqual(['product-3']);
  });
});

describe('facet counts', () => {
  beforeEach(async () => {
    await repository.save(
      product(1, {
        brand: 'Lenovo',
        optionNames: ['Colour'],
        variants: [
          variant('A1', 10000, [{ name: 'Colour', value: 'Black' }]),
          variant('A2', 12000, [{ name: 'Colour', value: 'Silver' }]),
        ],
      }),
    );
    await repository.save(
      product(2, {
        brand: 'Lenovo',
        optionNames: ['Colour'],
        variants: [variant('B1', 20000, [{ name: 'Colour', value: 'Black' }])],
      }),
    );
    await repository.save(
      product(3, {
        brand: 'Dell',
        optionNames: ['Colour'],
        variants: [variant('C1', 30000, [{ name: 'Colour', value: 'Silver' }])],
      }),
    );
  });

  it('counts products per brand', async () => {
    const { facets } = await search({});
    expect(facets.brands).toEqual([
      { value: 'Lenovo', count: 2 },
      { value: 'Dell', count: 1 },
    ]);
  });

  it('counts a product once per option value, not once per variant', async () => {
    // product-1 has two Black... no: one Black and one Silver. If counting were
    // per-variant, a product with three Black variants would inflate the count
    // and the customer would see "Black (5)" over three products.
    const { facets } = await search({});
    const colour = facets.options.find((option) => option.name === 'Colour');
    expect(colour?.values).toEqual([
      { value: 'Black', count: 2 },
      { value: 'Silver', count: 2 },
    ]);
  });

  it('reports the price range across everything matched', async () => {
    const { facets } = await search({});
    expect(facets.priceRange).toEqual({ minCents: 10000, maxCents: 30000 });
  });

  it('keeps every brand in the list when one brand is selected', async () => {
    // The behaviour that makes facets usable: selecting Lenovo must not collapse
    // the brand list to Lenovo, or the customer cannot switch to Dell without
    // first clearing the filter.
    const { facets, products } = await search({ brands: ['Lenovo'] });
    expect(products).toHaveLength(2);
    expect(facets.brands.map((b) => b.value).sort()).toEqual(['Dell', 'Lenovo']);
  });

  it('narrows the OTHER facets when a brand is selected', async () => {
    const { facets } = await search({ brands: ['Dell'] });
    const colour = facets.options.find((option) => option.name === 'Colour');
    // Only Dell's Silver remains.
    expect(colour?.values).toEqual([{ value: 'Silver', count: 1 }]);
  });

  it('keeps every option value when that option is filtered', async () => {
    const { facets } = await search({ options: [{ name: 'Colour', values: ['Black'] }] });
    const colour = facets.options.find((option) => option.name === 'Colour');
    expect(colour?.values.map((v) => v.value).sort()).toEqual(['Black', 'Silver']);
  });

  it('reports the price range ignoring the price filter itself', async () => {
    // Otherwise the slider collapses to the handles the customer just moved.
    const { facets } = await search({ priceMinCents: 15000, priceMaxCents: 25000 });
    expect(facets.priceRange).toEqual({ minCents: 10000, maxCents: 30000 });
  });

  it('has no price range when nothing matches', async () => {
    const { facets } = await search({ search: 'zzzznothing' });
    expect(facets.priceRange).toBeNull();
  });

  it('excludes drafts from the counts', async () => {
    await repository.save(product(9, { brand: 'Ghost', status: 'draft' }));
    const { facets } = await search({});
    expect(facets.brands.map((b) => b.value)).not.toContain('Ghost');
  });
});

describe('pagination', () => {
  beforeEach(async () => {
    for (let n = 1; n <= 5; n++) {
      await repository.save(product(n, { brand: 'Lenovo' }));
    }
  });

  it('paginates filtered results with a cursor', async () => {
    const first = await search({ brands: ['Lenovo'] }, 2);
    expect(first.products).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await repository.search({
      storeId: 'taz4tech',
      status: 'active',
      limit: 2,
      cursor: first.nextCursor ?? '',
      filters: { brands: ['Lenovo'] },
    });
    expect(second.products).toHaveLength(2);
    const seen = [...first.products, ...second.products].map((p) => p.slug);
    expect(new Set(seen).size).toBe(4);
  });

  it('reports no cursor on the last page', async () => {
    const result = await search({}, 10);
    expect(result.products).toHaveLength(5);
    expect(result.nextCursor).toBeNull();
  });
});

describe('query plans', () => {
  beforeEach(async () => {
    await repository.save(product(1, { brand: 'Lenovo', title: { en: 'Lenovo Laptop' } }));
  });

  it('serves a text search from the text index', async () => {
    const explained = await db
      .collection(PRODUCTS_COLLECTION)
      .find({ storeId: 'taz4tech', $text: { $search: 'lenovo' } })
      .explain('queryPlanner');

    const stages = winningStages(explained);
    expect(stages).not.toEqual([]);
    expect(scansCollection(stages), stages.join(', ')).toBe(false);
  });

  it('serves an unfiltered listing from an index', async () => {
    const explained = await db
      .collection(PRODUCTS_COLLECTION)
      .find({ storeId: 'taz4tech', status: 'active' })
      .sort({ _id: -1 })
      .explain('queryPlanner');

    const stages = winningStages(explained);
    expect(scansCollection(stages), stages.join(', ')).toBe(false);
    expect(usesIndex(stages), stages.join(', ')).toBe(true);
  });
});
