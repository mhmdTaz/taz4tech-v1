import { englishOnly } from '@platform/locale';
import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { type Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scansCollection, sortsInMemory, usesIndex, winningStages } from '@/test-support/explain';
import type { Product, ProductId, ProductStatus } from '../domain/product';
import {
  createMongoProductRepository,
  ensureProductIndexes,
  PRODUCTS_COLLECTION,
} from './mongo-product-repository';

const URI = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_TEST_DB ?? 'taz4tech_test';

let client: MongoClient;
let db: Db;

const usd = (cents: number) => unwrapOrThrow(fromCents(cents));
const CREATED = new Date('2026-08-01T10:00:00Z');

/** Ids are ULID-shaped, so a higher id sorts as newer. */
const id = (n: number): ProductId => `PRODUCT${String(n).padStart(19, '0')}` as ProductId;

const product = (overrides: Partial<Product> = {}): Product => ({
  storeId: 'taz4tech',
  id: id(1),
  slug: 'lenovo-ideapad-3',
  title: englishOnly('Lenovo IdeaPad 3'),
  description: englishOnly('A laptop.'),
  brand: 'Lenovo',
  status: 'active',
  optionNames: [],
  variants: [
    {
      sku: 'SKU-1',
      options: [],
      price: usd(129900),
      compareAtPrice: null,
      offerEndsAt: null,
      barcode: null,
      weightGrams: null,
    },
  ],
  media: [],
  specs: [],
  createdAt: CREATED,
  updatedAt: CREATED,
  ...overrides,
});

const explainOf = async (filter: Record<string, unknown>, sort?: Record<string, 1 | -1>) => {
  const cursor = db.collection(PRODUCTS_COLLECTION).find(filter);
  if (sort !== undefined) cursor.sort(sort);
  // winningStages, not the whole queryPlanner: rejectedPlans would otherwise
  // let a discarded plan satisfy or break an assertion about the real one.
  return winningStages(await cursor.explain('queryPlanner'));
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
    .collection(PRODUCTS_COLLECTION)
    .drop()
    .catch(() => undefined);
  await ensureProductIndexes(db);
});

/** Distinct SKU per product — the unique index forbids reuse, correctly. */
const productWithSku = (n: number, slug: string): Product =>
  product({
    id: id(n),
    slug,
    variants: [
      {
        sku: `SKU-${n}`,
        options: [],
        price: usd(1000 * n),
        compareAtPrice: null,
        offerEndsAt: null,
        barcode: null,
        weightGrams: null,
      },
    ],
  });

describe('MongoProductRepository', () => {
  it('round-trips a product exactly, including money and dates', async () => {
    const repository = createMongoProductRepository(db);
    const original = product({
      brand: 'Lenovo',
      optionNames: ['Colour'],
      variants: [
        {
          sku: 'IP3-BLK',
          options: [{ name: 'Colour', value: 'Black' }],
          price: usd(129900),
          compareAtPrice: usd(149900),
          offerEndsAt: new Date('2026-12-01T00:00:00Z'),
          barcode: '1234567890123',
          weightGrams: 1600,
        },
      ],
      media: [
        { kind: 'image', url: '/a.webp', alt: englishOnly('Front'), width: 800, height: 600 },
      ],
      specs: [{ name: englishOnly('RAM'), value: englishOnly('8 GB'), group: 'Memory' }],
    });

    await repository.save(original);
    const found = await repository.findBySlug('taz4tech', 'lenovo-ideapad-3');

    expect(found).toEqual(original);
    // Explicit: an amount must survive storage as exact integer cents.
    expect(found?.variants[0]?.price.cents).toBe(129900);
    expect(found?.variants[0]?.offerEndsAt).toBeInstanceOf(Date);
  });

  it('preserves a partially translated title', async () => {
    const repository = createMongoProductRepository(db);
    await repository.save(product({ title: { en: 'Laptop', ar: 'حاسوب محمول' } }));

    const found = await repository.findBySlug('taz4tech', 'lenovo-ideapad-3');
    expect(found?.title).toEqual({ en: 'Laptop', ar: 'حاسوب محمول' });
    // The absent locale is omitted, not stored as undefined.
    expect(Object.hasOwn(found?.title ?? {}, 'fr')).toBe(false);
  });

  it('returns null for a slug that does not exist', async () => {
    const repository = createMongoProductRepository(db);
    expect(await repository.findBySlug('taz4tech', 'nothing')).toBeNull();
  });

  it('never returns another tenant’s product', async () => {
    const repository = createMongoProductRepository(db);
    await repository.save(product({ storeId: 'tenant-a', id: id(1) }));
    await repository.save(product({ storeId: 'tenant-b', id: id(2) }));

    expect((await repository.findBySlug('tenant-a', 'lenovo-ideapad-3'))?.storeId).toBe('tenant-a');
    expect((await repository.findBySlug('tenant-b', 'lenovo-ideapad-3'))?.storeId).toBe('tenant-b');
    expect(await repository.findBySlug('tenant-c', 'lenovo-ideapad-3')).toBeNull();
  });

  it('finds a product by any of its variant SKUs', async () => {
    const repository = createMongoProductRepository(db);
    await repository.save(
      product({
        optionNames: ['Colour'],
        variants: [
          {
            sku: 'A-1',
            options: [{ name: 'Colour', value: 'Black' }],
            price: usd(1000),
            compareAtPrice: null,
            offerEndsAt: null,
            barcode: null,
            weightGrams: null,
          },
          {
            sku: 'A-2',
            options: [{ name: 'Colour', value: 'Silver' }],
            price: usd(1000),
            compareAtPrice: null,
            offerEndsAt: null,
            barcode: null,
            weightGrams: null,
          },
        ],
      }),
    );

    expect((await repository.findBySku('taz4tech', 'A-2'))?.slug).toBe('lenovo-ideapad-3');
    expect(await repository.findBySku('taz4tech', 'A-3')).toBeNull();
  });

  it('finds a product by id, scoped to its tenant', async () => {
    const repository = createMongoProductRepository(db);
    await repository.save(product({ id: id(7) }));
    expect((await repository.findById('taz4tech', id(7)))?.id).toBe(id(7));
    expect(await repository.findById('other', id(7))).toBeNull();
  });

  describe('findBySkus', () => {
    it('finds the product that owns each SKU, in one query', async () => {
      const repository = createMongoProductRepository(db);
      await repository.save(productWithSku(1, 'a'));
      await repository.save(productWithSku(2, 'b'));

      const found = await repository.findBySkus('taz4tech', ['SKU-1', 'SKU-9']);
      expect(found.map((p) => p.slug)).toEqual(['a']);
    });

    it('finds a product by a SKU on any of its variants, not just the first', async () => {
      // The importer asks about every SKU in the sheet; a product whose SECOND
      // variant owns the SKU is exactly as much of a conflict as the first.
      const repository = createMongoProductRepository(db);
      await repository.save(
        product({
          id: id(7),
          slug: 'two-variants',
          optionNames: ['Length'],
          variants: [
            {
              sku: 'MULTI-A',
              options: [{ name: 'Length', value: '1m' }],
              price: usd(1000),
              compareAtPrice: null,
              offerEndsAt: null,
              barcode: null,
              weightGrams: null,
            },
            {
              sku: 'MULTI-B',
              options: [{ name: 'Length', value: '2m' }],
              price: usd(2000),
              compareAtPrice: null,
              offerEndsAt: null,
              barcode: null,
              weightGrams: null,
            },
          ],
        }),
      );

      const found = await repository.findBySkus('taz4tech', ['MULTI-B']);
      expect(found.map((p) => p.slug)).toEqual(['two-variants']);
    });

    it('returns nothing for an empty list without querying', async () => {
      expect(await createMongoProductRepository(db).findBySkus('taz4tech', [])).toEqual([]);
    });

    it('never crosses tenants', async () => {
      const repository = createMongoProductRepository(db);
      await repository.save(product({ storeId: 'tenant-a', id: id(1), slug: 'shared' }));
      expect(await repository.findBySkus('tenant-b', ['SKU-1'])).toEqual([]);
    });

    it('uses an index rather than scanning', async () => {
      const repository = createMongoProductRepository(db);
      await repository.save(productWithSku(1, 'a'));

      const stages = await explainOf({ storeId: 'taz4tech', 'variants.sku': { $in: ['SKU-1'] } });
      expect(scansCollection(stages), stages.join(', ')).toBe(false);
      expect(usesIndex(stages), stages.join(', ')).toBe(true);
    });
  });

  describe('save, when a unique index refuses the write', () => {
    it('reports a SKU already owned by another product instead of throwing', async () => {
      /*
       * The crash this replaces: the importer used to let E11000 escape, so a
       * renamed product with an unchanged SKU produced a 500 halfway through the
       * write, with everything before it already saved.
       */
      const repository = createMongoProductRepository(db);
      await repository.save(productWithSku(1, 'original'));

      const thief = product({
        id: id(2),
        slug: 'renamed',
        variants: [
          {
            sku: 'SKU-1',
            options: [],
            price: usd(5000),
            compareAtPrice: null,
            offerEndsAt: null,
            barcode: null,
            weightGrams: null,
          },
        ],
      });

      expect(await repository.save(thief)).toEqual({
        ok: false,
        error: { tag: 'sku_taken', sku: 'SKU-1' },
      });
    });

    it('reports a slug already taken by another product', async () => {
      const repository = createMongoProductRepository(db);
      await repository.save(productWithSku(1, 'taken'));

      expect(await repository.save(productWithSku(2, 'taken'))).toEqual({
        ok: false,
        error: { tag: 'slug_taken', slug: 'taken' },
      });
    });

    it('is an ordinary success when the same product keeps its own SKU', async () => {
      // The common case — a re-imported price list — must not be mistaken for a
      // conflict just because the SKU already exists.
      const repository = createMongoProductRepository(db);
      const original = productWithSku(1, 'a');
      expect(await repository.save(original)).toEqual({ ok: true, value: undefined });
      expect(await repository.save({ ...original, brand: 'Updated' })).toEqual({
        ok: true,
        value: undefined,
      });

      expect((await repository.findBySlug('taz4tech', 'a'))?.brand).toBe('Updated');
    });
  });

  describe('findBySlugs', () => {
    it('returns every match in one query', async () => {
      const repository = createMongoProductRepository(db);
      await repository.save(productWithSku(1, 'a'));
      await repository.save(productWithSku(2, 'b'));
      await repository.save(productWithSku(3, 'c'));

      const found = await repository.findBySlugs('taz4tech', ['a', 'c', 'missing']);
      expect(found.map((p) => p.slug).sort()).toEqual(['a', 'c']);
    });

    it('returns nothing for an empty list without querying', async () => {
      expect(await createMongoProductRepository(db).findBySlugs('taz4tech', [])).toEqual([]);
    });

    it('never crosses tenants', async () => {
      const repository = createMongoProductRepository(db);
      await repository.save(product({ storeId: 'tenant-a', id: id(1), slug: 'shared' }));
      expect(await repository.findBySlugs('tenant-b', ['shared'])).toEqual([]);
    });

    it('uses an index rather than scanning', async () => {
      const repository = createMongoProductRepository(db);
      await repository.save(productWithSku(1, 'a'));

      const stages = await explainOf({ storeId: 'taz4tech', slug: { $in: ['a', 'b'] } });
      expect(scansCollection(stages), stages.join(', ')).toBe(false);
      expect(usesIndex(stages), stages.join(', ')).toBe(true);
    });
  });

  it('upserts rather than duplicating on a second save', async () => {
    const repository = createMongoProductRepository(db);
    await repository.save(product());
    await repository.save(product({ title: englishOnly('Renamed') }));

    expect(await db.collection(PRODUCTS_COLLECTION).countDocuments({})).toBe(1);
    expect((await repository.findBySlug('taz4tech', 'lenovo-ideapad-3'))?.title.en).toBe('Renamed');
  });

  describe('uniqueness', () => {
    /*
     * The constraint is unchanged; how it is REPORTED changed. save() used to
     * let Mongo's E11000 escape, which made a duplicate SKU a 500 halfway
     * through an import. It now returns an Err naming the field that collided,
     * so a caller can say which row of the spreadsheet is at fault and carry on
     * with the rest.
     */
    it('rejects two products sharing a slug within one store', async () => {
      const repository = createMongoProductRepository(db);
      await repository.save(product({ id: id(1) }));
      expect(await repository.save(product({ id: id(2) }))).toEqual({
        ok: false,
        error: { tag: 'slug_taken', slug: 'lenovo-ideapad-3' },
      });
    });

    it('allows the same slug in a different store', async () => {
      const repository = createMongoProductRepository(db);
      await repository.save(product({ storeId: 'tenant-a', id: id(1) }));
      expect(await repository.save(product({ storeId: 'tenant-b', id: id(2) }))).toEqual({
        ok: true,
        value: undefined,
      });
    });

    it('rejects a SKU reused across two products in one store', async () => {
      // A SKU identifies exactly one sellable thing. Two products sharing one
      // would make stock and the importer's insert-vs-update decision ambiguous.
      const repository = createMongoProductRepository(db);
      await repository.save(product({ id: id(1), slug: 'first' }));
      expect(await repository.save(product({ id: id(2), slug: 'second' }))).toEqual({
        ok: false,
        error: { tag: 'sku_taken', sku: 'SKU-1' },
      });
    });

    it('still writes exactly one document after a refused write', async () => {
      // A conflict that is REPORTED rather than thrown must not also have
      // written something. Returning ok:false while leaving a partial row behind
      // would be worse than the exception it replaced.
      const repository = createMongoProductRepository(db);
      await repository.save(product({ id: id(1) }));
      await repository.save(product({ id: id(2) }));

      expect(await db.collection(PRODUCTS_COLLECTION).countDocuments({})).toBe(1);
    });
  });

  describe('listing', () => {
    const seed = async (count: number, status: ProductStatus = 'active') => {
      const repository = createMongoProductRepository(db);
      for (let i = 1; i <= count; i++) {
        await repository.save(
          product({
            id: id(i),
            slug: `product-${i}`,
            status,
            variants: [
              {
                sku: `SKU-${i}`,
                options: [],
                price: usd(1000 * i),
                compareAtPrice: null,
                offerEndsAt: null,
                barcode: null,
                weightGrams: null,
              },
            ],
          }),
        );
      }
      return repository;
    };

    it('returns newest first', async () => {
      const repository = await seed(3);
      const page = await repository.list({ storeId: 'taz4tech', limit: 10 });
      expect(page.products.map((p) => p.slug)).toEqual(['product-3', 'product-2', 'product-1']);
      expect(page.nextCursor).toBeNull();
    });

    it('paginates with a cursor, with no gaps or repeats', async () => {
      const repository = await seed(5);

      const first = await repository.list({ storeId: 'taz4tech', limit: 2 });
      expect(first.products.map((p) => p.slug)).toEqual(['product-5', 'product-4']);
      expect(first.nextCursor).not.toBeNull();

      const second = await repository.list({
        storeId: 'taz4tech',
        limit: 2,
        cursor: first.nextCursor ?? '',
      });
      expect(second.products.map((p) => p.slug)).toEqual(['product-3', 'product-2']);

      const third = await repository.list({
        storeId: 'taz4tech',
        limit: 2,
        cursor: second.nextCursor ?? '',
      });
      expect(third.products.map((p) => p.slug)).toEqual(['product-1']);
      expect(third.nextCursor).toBeNull();
    });

    it('reports no next cursor when the last page is exactly full', async () => {
      // The off-by-one that matters: 4 products at limit 2 must end after the
      // second page, not offer a third that is empty.
      const repository = await seed(4);
      const first = await repository.list({ storeId: 'taz4tech', limit: 2 });
      const second = await repository.list({
        storeId: 'taz4tech',
        limit: 2,
        cursor: first.nextCursor ?? '',
      });
      expect(second.products).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
    });

    it('filters by status', async () => {
      const repository = await seed(2, 'draft');
      expect(
        (await repository.list({ storeId: 'taz4tech', limit: 10, status: 'active' })).products,
      ).toHaveLength(0);
      expect(
        (await repository.list({ storeId: 'taz4tech', limit: 10, status: 'draft' })).products,
      ).toHaveLength(2);
    });

    it('never lists another tenant’s products', async () => {
      await seed(2);
      const repository = createMongoProductRepository(db);
      expect((await repository.list({ storeId: 'someone-else', limit: 10 })).products).toEqual([]);
    });

    it('returns an empty page for an empty catalogue', async () => {
      const repository = createMongoProductRepository(db);
      const page = await repository.list({ storeId: 'taz4tech', limit: 10 });
      expect(page.products).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });
  });

  describe('query plans', () => {
    beforeEach(async () => {
      await createMongoProductRepository(db).save(product());
    });

    it('looks up by slug through an index', async () => {
      const stages = await explainOf({ storeId: 'taz4tech', slug: 'lenovo-ideapad-3' });
      expect(stages).not.toEqual([]);
      expect(scansCollection(stages), stages.join(', ')).toBe(false);
      expect(usesIndex(stages), stages.join(', ')).toBe(true);
    });

    it('looks up by SKU through an index', async () => {
      const stages = await explainOf({ storeId: 'taz4tech', 'variants.sku': 'SKU-1' });
      expect(scansCollection(stages), stages.join(', ')).toBe(false);
      expect(usesIndex(stages), stages.join(', ')).toBe(true);
    });

    it('serves the sorted listing from an index, with no in-memory sort', async () => {
      const stages = await explainOf({ storeId: 'taz4tech', status: 'active' }, { _id: -1 });
      expect(scansCollection(stages), stages.join(', ')).toBe(false);
      expect(usesIndex(stages), stages.join(', ')).toBe(true);
      // A SORT stage would mean the index did not supply the order, which stops
      // being viable the moment the catalogue outgrows the sort memory limit.
      expect(sortsInMemory(stages), stages.join(', ')).toBe(false);
    });

    it('the COLLSCAN detector still detects a collection scan', async () => {
      // Negative control. Without it, a walker returning the wrong shape would
      // make every assertion above pass vacuously.
      const stages = await explainOf({ brand: 'Lenovo' });
      expect(scansCollection(stages)).toBe(true);
    });
  });

  describe('untrusted stored documents', () => {
    it('rejects a malformed document instead of rendering undefined', async () => {
      await db
        .collection(PRODUCTS_COLLECTION)
        .insertOne({ _id: id(9), storeId: 'taz4tech', slug: 'broken' } as never);

      await expect(
        createMongoProductRepository(db).findBySlug('taz4tech', 'broken'),
      ).rejects.toThrow(/malformed/);
    });

    it('rejects a document that violates a domain invariant', async () => {
      const repository = createMongoProductRepository(db);
      await repository.save(product());
      // Reach past the repository to write something the domain would reject.
      await db
        .collection(PRODUCTS_COLLECTION)
        .updateOne({ _id: id(1) } as never, { $set: { slug: 'Not A Slug' } });

      await expect(repository.findById('taz4tech', id(1))).rejects.toThrow(/invariant/);
    });
  });
});
