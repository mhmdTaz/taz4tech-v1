import { englishOnly } from '@platform/locale';
import { describe, expect, it, vi } from 'vitest';
import type { CollectionRepository, ProductRepository } from '../contracts';
import type { Collection } from '../domain/collection';
import type { Product, ProductId } from '../domain/product';
import { makeSaveCollection } from './save-collection';

const NOW = new Date('2026-08-27T10:00:00Z');
const pid = (n: number) => `PRODUCT${String(n).padStart(19, '0')}` as ProductId;

const collection = (overrides: Partial<Collection> = {}): Collection => ({
  storeId: 'taz4tech',
  id: 'COLLECTION000000000000AAA',
  slug: 'laptops',
  title: englishOnly('Laptops'),
  description: englishOnly('Every laptop.'),
  status: 'active',
  rules: { brands: ['Lenovo'] },
  pinnedProductIds: [],
  sort: 'newest',
  position: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const wiring = (options: { existing?: Collection | null; productExists?: boolean } = {}) => {
  const repo: CollectionRepository = {
    findBySlug: vi.fn().mockResolvedValue(options.existing ?? null),
    findById: vi.fn(),
    list: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const products: ProductRepository = {
    findBySlug: vi.fn(),
    findById: vi
      .fn()
      .mockResolvedValue(options.productExists === false ? null : ({ id: pid(1) } as Product)),
    findBySku: vi.fn(),
    findBySlugs: vi.fn(),
    list: vi.fn(),
    save: vi.fn(),
    search: vi.fn(),
  };
  return {
    repo,
    products,
    save: makeSaveCollection({ repository: repo, products, storeId: 'taz4tech' }),
  };
};

describe('saveCollection', () => {
  it('validates and stores a well-formed collection', async () => {
    const { repo, save } = wiring();
    const result = await save(collection());
    expect(result.ok).toBe(true);
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('normalises before saving', async () => {
    const { repo, save } = wiring();
    await save(collection({ title: { en: '  Laptops  ' } }));
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.objectContaining({ en: 'Laptops' }) }),
    );
  });

  it('refuses another tenant’s collection before doing anything else', async () => {
    const { repo, save } = wiring();
    const result = await save(collection({ storeId: 'someone-else', slug: 'not a slug' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('wrong_tenant');
    expect(repo.findBySlug).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rejects input the domain considers invalid', async () => {
    const { repo, save } = wiring();
    const result = await save(collection({ rules: {}, pinnedProductIds: [] }));

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.tag === 'invalid') {
      expect(result.error.reason.tag).toBe('no_membership');
    }
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('reports a slug already used by a different collection', async () => {
    const { repo, save } = wiring({
      existing: collection({ id: 'COLLECTION000000000000BBB' }),
    });
    const result = await save(collection());

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.tag === 'slug_taken') {
      expect(result.error.slug).toBe('laptops');
    }
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('allows a collection to keep its own slug when updated', async () => {
    const { repo, save } = wiring({ existing: collection() });
    const result = await save(collection({ title: englishOnly('Renamed') }));
    expect(result.ok).toBe(true);
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('rejects a pinned product that does not exist', async () => {
    // A dangling id is silent otherwise: the collection shows one product fewer
    // than the curator arranged, with nothing saying why.
    const { repo, save } = wiring({ productExists: false });
    const result = await save(collection({ pinnedProductIds: [pid(1)] }));

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.tag === 'pinned_product_missing') {
      expect(result.error.productId).toBe(pid(1));
    }
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('accepts pinned products that do exist', async () => {
    const { products, save } = wiring();
    const result = await save(collection({ pinnedProductIds: [pid(1), pid(2)] }));
    expect(result.ok).toBe(true);
    expect(products.findById).toHaveBeenCalledTimes(2);
  });

  it('checks pinned products against the right tenant', async () => {
    const { products, save } = wiring();
    await save(collection({ pinnedProductIds: [pid(1)] }));
    expect(products.findById).toHaveBeenCalledWith('taz4tech', pid(1));
  });

  it('lets a repository failure propagate', async () => {
    const { repo, products } = wiring();
    repo.save = vi.fn().mockRejectedValue(new Error('write concern timeout'));
    const save = makeSaveCollection({ repository: repo, products, storeId: 'taz4tech' });
    await expect(save(collection())).rejects.toThrow('write concern timeout');
  });
});
