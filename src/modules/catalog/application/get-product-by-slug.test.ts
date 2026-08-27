import { englishOnly } from '@platform/locale';
import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { describe, expect, it, vi } from 'vitest';
import type { ProductRepository } from '../contracts';
import type { Product, ProductStatus } from '../domain/product';
import { makeGetProductBySlug } from './get-product-by-slug';

const NOW = new Date('2026-08-27T10:00:00Z');

const product = (status: ProductStatus = 'active'): Product => ({
  storeId: 'taz4tech',
  id: 'PRODUCT0000000000000000AA',
  slug: 'lenovo-ideapad-3',
  title: englishOnly('Lenovo IdeaPad 3'),
  description: englishOnly('A laptop.'),
  brand: 'Lenovo',
  status,
  optionNames: [],
  variants: [
    {
      sku: 'SKU-1',
      options: [],
      price: unwrapOrThrow(fromCents(129900)),
      compareAtPrice: null,
      offerEndsAt: null,
      barcode: null,
      weightGrams: null,
    },
  ],
  media: [],
  specs: [],
  createdAt: NOW,
  updatedAt: NOW,
});

const repositoryReturning = (value: Product | null) => {
  const findBySlug = vi.fn().mockResolvedValue(value);
  const repo: ProductRepository = {
    findBySlug,
    findById: vi.fn(),
    findBySku: vi.fn(),
    findBySlugs: vi.fn().mockResolvedValue([]),
    findBySkus: vi.fn().mockResolvedValue([]),
    findByIds: vi.fn().mockResolvedValue([]),
    search: vi.fn(),
    list: vi.fn(),
    save: vi.fn(),
  };
  return { repo, findBySlug };
};

const get = (repo: ProductRepository) =>
  makeGetProductBySlug({ repository: repo, storeId: 'taz4tech' });

describe('getProductBySlug', () => {
  it('returns an active product', async () => {
    const { repo } = repositoryReturning(product());
    const result = await get(repo)('lenovo-ideapad-3');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.slug).toBe('lenovo-ideapad-3');
  });

  it('normalises the slug before looking it up', async () => {
    // A pasted URL can arrive with stray case or whitespace; two spellings of
    // the same product must not be a 404 for one customer and a page for another.
    const { repo, findBySlug } = repositoryReturning(product());
    await get(repo)('  Lenovo-IdeaPad-3  ');
    expect(findBySlug).toHaveBeenCalledExactlyOnceWith('taz4tech', 'lenovo-ideapad-3');
  });

  it('asks only for the tenant it was wired with', async () => {
    const { repo, findBySlug } = repositoryReturning(product());
    await makeGetProductBySlug({ repository: repo, storeId: 'other-tenant' })('x-y');
    expect(findBySlug).toHaveBeenCalledExactlyOnceWith('other-tenant', 'x-y');
  });

  it('reports not_found for an empty slug without querying', async () => {
    const { repo, findBySlug } = repositoryReturning(product());
    const result = await get(repo)('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('not_found');
    expect(findBySlug).not.toHaveBeenCalled();
  });

  it('reports not_found when nothing matches', async () => {
    const { repo } = repositoryReturning(null);
    const result = await get(repo)('missing');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe('not_found');
      expect(result.error.slug).toBe('missing');
    }
  });

  it.each<ProductStatus>(['draft', 'archived'])(
    'hides a %s product from the storefront',
    async (status) => {
      const { repo } = repositoryReturning(product(status));
      const result = await get(repo)('lenovo-ideapad-3');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('not_available');
    },
  );

  it.each<ProductStatus>(['draft', 'archived'])(
    'shows a %s product to an admin preview',
    async (status) => {
      const { repo } = repositoryReturning(product(status));
      const result = await get(repo)('lenovo-ideapad-3', { includeUnpublished: true });
      expect(result.ok).toBe(true);
    },
  );

  it('distinguishes unpublished from missing', async () => {
    // Both render 404 on the storefront, but the admin preview needs to tell
    // "this is a draft" from "this does not exist" without a second query path.
    const { repo: draftRepo } = repositoryReturning(product('draft'));
    const draft = await get(draftRepo)('lenovo-ideapad-3');

    const { repo: emptyRepo } = repositoryReturning(null);
    const missing = await get(emptyRepo)('lenovo-ideapad-3');

    expect(draft.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (!draft.ok && !missing.ok) expect(draft.error.tag).not.toBe(missing.error.tag);
  });

  it('treats includeUnpublished:false the same as omitting it', async () => {
    const { repo } = repositoryReturning(product('draft'));
    const result = await get(repo)('lenovo-ideapad-3', { includeUnpublished: false });
    expect(result.ok).toBe(false);
  });

  it('lets a repository failure propagate', async () => {
    const repo: ProductRepository = {
      findBySlug: vi.fn().mockRejectedValue(new Error('connection refused')),
      findById: vi.fn(),
      findBySku: vi.fn(),
      findBySlugs: vi.fn().mockResolvedValue([]),
      findBySkus: vi.fn().mockResolvedValue([]),
      findByIds: vi.fn().mockResolvedValue([]),
      search: vi.fn(),
      list: vi.fn(),
      save: vi.fn(),
    };
    await expect(get(repo)('lenovo-ideapad-3')).rejects.toThrow('connection refused');
  });
});
