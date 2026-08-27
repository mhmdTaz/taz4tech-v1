import type { EntityId } from '@platform/ids';
import { englishOnly } from '@platform/locale';
import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { describe, expect, it, vi } from 'vitest';
import { fakeProductRepository } from '@/test-support/catalog';
import type { Product, ProductStatus, Variant } from '../domain/product';
import { MAX_SKU_LOOKUP, makeGetProductsBySkus } from './get-products-by-skus';

const NOW = new Date('2026-08-27T10:00:00Z');
const usd = (cents: number) => unwrapOrThrow(fromCents(cents));

const variant = (sku: string): Variant => ({
  sku,
  options: [],
  price: usd(1999),
  compareAtPrice: null,
  offerEndsAt: null,
  barcode: null,
  weightGrams: null,
});

const product = (slug: string, skus: string[], status: ProductStatus = 'active'): Product => ({
  storeId: 'taz4tech',
  id: `PRODUCT${slug}` as EntityId<'Product'>,
  slug,
  title: englishOnly(slug),
  description: englishOnly('A thing.'),
  brand: null,
  status,
  optionNames: skus.length > 1 ? ['Size'] : [],
  variants: skus.map((sku) => ({
    ...variant(sku),
    options: skus.length > 1 ? [{ name: 'Size', value: sku }] : [],
  })),
  media: [],
  specs: [],
  createdAt: NOW,
  updatedAt: NOW,
});

const lookup = (products: Product[]) => {
  const findBySkus = vi.fn(async (_storeId: string, skus: readonly string[]) =>
    products.filter((candidate) => candidate.variants.some((each) => skus.includes(each.sku))),
  );
  const repository = fakeProductRepository({ findBySkus });
  return { findBySkus, get: makeGetProductsBySkus({ repository, storeId: 'taz4tech' }) };
};

describe('getProductsBySkus', () => {
  it('maps each SKU to the product that owns it', async () => {
    const { get } = lookup([product('a', ['SKU-1'])]);
    const found = await get({ skus: ['SKU-1'] });

    expect(found.get('SKU-1')?.slug).toBe('a');
  });

  it('leaves a SKU that resolves to nothing absent', async () => {
    const { get } = lookup([]);
    expect((await get({ skus: ['NOPE'] })).has('NOPE')).toBe(false);
  });

  it('maps only the SKUs that were ASKED for', async () => {
    /*
     * A multi-variant product comes back whole. Indexing every one of its SKUs
     * would let a cart line for a variant nobody requested resolve — and be
     * priced — off the back of a lookup for a different one.
     */
    const { get } = lookup([product('a', ['SKU-1', 'SKU-2'])]);
    const found = await get({ skus: ['SKU-1'] });

    expect(found.has('SKU-1')).toBe(true);
    expect(found.has('SKU-2')).toBe(false);
  });

  it('maps several SKUs of one product when all are asked for', async () => {
    const { get } = lookup([product('a', ['SKU-1', 'SKU-2'])]);
    const found = await get({ skus: ['SKU-1', 'SKU-2'] });

    expect([...found.keys()].sort()).toEqual(['SKU-1', 'SKU-2']);
  });

  describe('the status gate', () => {
    it('hides a draft from a storefront caller', async () => {
      // The single gate again. A product archived while a cart sat open must
      // stop being purchasable, and it stops HERE rather than in whatever
      // renders it.
      const { get } = lookup([product('a', ['SKU-1'], 'draft')]);
      expect((await get({ skus: ['SKU-1'] })).size).toBe(0);
    });

    it('hides an archived product from a storefront caller', async () => {
      const { get } = lookup([product('a', ['SKU-1'], 'archived')]);
      expect((await get({ skus: ['SKU-1'] })).size).toBe(0);
    });

    it('shows them to a caller that explicitly asks', async () => {
      const { get } = lookup([product('a', ['SKU-1'], 'draft')]);
      expect((await get({ skus: ['SKU-1'], includeUnpublished: true })).size).toBe(1);
    });

    it('keeps the active products when one in the batch is a draft', async () => {
      const { get } = lookup([product('a', ['SKU-1']), product('b', ['SKU-2'], 'draft')]);
      const found = await get({ skus: ['SKU-1', 'SKU-2'] });

      expect(found.has('SKU-1')).toBe(true);
      expect(found.has('SKU-2')).toBe(false);
    });
  });

  describe('bounding the request', () => {
    it('asks once for a repeated SKU', async () => {
      const { findBySkus, get } = lookup([]);
      await get({ skus: ['A', 'A', 'A'] });
      expect(findBySkus).toHaveBeenCalledWith('taz4tech', ['A']);
    });

    it('drops blank SKUs rather than querying for them', async () => {
      const { findBySkus, get } = lookup([]);
      await get({ skus: ['A', '  ', ''] });
      expect(findBySkus).toHaveBeenCalledWith('taz4tech', ['A']);
    });

    it('does not query at all for an empty list', async () => {
      const { findBySkus, get } = lookup([]);
      expect((await get({ skus: [] })).size).toBe(0);
      expect(findBySkus).not.toHaveBeenCalled();
    });

    it('caps how many SKUs one call can ask about', async () => {
      // A cart cannot hold more lines than this, so neither can one lookup.
      const { findBySkus, get } = lookup([]);
      await get({ skus: Array.from({ length: MAX_SKU_LOOKUP + 20 }, (_, i) => `S-${i}`) });

      expect(findBySkus.mock.calls[0]?.[1]).toHaveLength(MAX_SKU_LOOKUP);
    });
  });
});
