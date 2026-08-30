import { englishOnly } from '@platform/locale';
import { describe, expect, it, vi } from 'vitest';
import type { CollectionRepository, ProductRepository, SearchProductsQuery } from '../contracts';
import type { Collection, CollectionStatus } from '../domain/collection';
import type { ProductId } from '../domain/product';
import {
  makeGetCollection,
  makeGetCollectionProducts,
  makeListCollections,
} from './get-collection';
import { MAX_PAGE_SIZE } from './list-products';

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

const collectionRepo = (value: Collection | null, all: Collection[] = []) => {
  const findBySlug = vi.fn().mockResolvedValue(value);
  const list = vi.fn().mockResolvedValue(all);
  const repo: CollectionRepository = { findBySlug, findById: vi.fn(), list, save: vi.fn() };
  return { repo, findBySlug, list };
};

const productRepo = () => {
  const calls: SearchProductsQuery[] = [];
  const repo: ProductRepository = {
    findBySlug: vi.fn(),
    findById: vi.fn(),
    findBySku: vi.fn(),
    findBySlugs: vi.fn(),
    findBySkus: vi.fn(async () => []),
    findByIds: vi.fn(async () => []),
    list: vi.fn(),
    save: vi.fn(),
    search: vi.fn(async (query: SearchProductsQuery) => {
      calls.push(query);
      return {
        products: [],
        nextCursor: null,
        facets: { brands: [], options: [], priceRange: null },
      };
    }),
  };
  return { repo, calls };
};

describe('getCollection', () => {
  const get = (repo: CollectionRepository) =>
    makeGetCollection({ repository: repo, storeId: 'taz4tech' });

  it('returns an active collection', async () => {
    const { repo } = collectionRepo(collection());
    const result = await get(repo)('laptops');
    expect(result.ok).toBe(true);
  });

  it('normalises the slug before looking it up', async () => {
    const { repo, findBySlug } = collectionRepo(collection());
    await get(repo)('  LAPTOPS  ');
    expect(findBySlug).toHaveBeenCalledExactlyOnceWith('taz4tech', 'laptops');
  });

  it('reports not_found for an empty slug without querying', async () => {
    const { repo, findBySlug } = collectionRepo(collection());
    const result = await get(repo)('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('not_found');
    expect(findBySlug).not.toHaveBeenCalled();
  });

  it('reports not_found when nothing matches', async () => {
    const { repo } = collectionRepo(null);
    const result = await get(repo)('missing');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('not_found');
  });

  it.each<CollectionStatus>(['draft', 'archived'])(
    'hides a %s collection from the storefront',
    async (status) => {
      const { repo } = collectionRepo(collection({ status }));
      const result = await get(repo)('laptops');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('not_available');
    },
  );

  it('shows a draft to an admin preview', async () => {
    const { repo } = collectionRepo(collection({ status: 'draft' }));
    const result = await get(repo)('laptops', { includeUnpublished: true });
    expect(result.ok).toBe(true);
  });

  it('treats includeUnpublished:false the same as omitting it', async () => {
    const { repo } = collectionRepo(collection({ status: 'draft' }));
    expect((await get(repo)('laptops', { includeUnpublished: false })).ok).toBe(false);
  });

  it('lets a repository failure propagate', async () => {
    const repo: CollectionRepository = {
      findBySlug: vi.fn().mockRejectedValue(new Error('connection refused')),
      findById: vi.fn(),
      list: vi.fn(),
      save: vi.fn(),
    };
    await expect(get(repo)('laptops')).rejects.toThrow('connection refused');
  });
});

describe('listCollections', () => {
  it('asks for active collections only by default', async () => {
    const { repo, list } = collectionRepo(null, []);
    await makeListCollections({ repository: repo, storeId: 'taz4tech' })();
    expect(list).toHaveBeenCalledExactlyOnceWith({ storeId: 'taz4tech', status: 'active' });
  });

  it('includes every status for an admin caller', async () => {
    const { repo, list } = collectionRepo(null, []);
    await makeListCollections({ repository: repo, storeId: 'taz4tech' })({
      includeUnpublished: true,
    });
    expect(list).toHaveBeenCalledExactlyOnceWith({ storeId: 'taz4tech' });
  });

  it('returns them in navigation order', async () => {
    const unsorted = [
      collection({ slug: 'c', position: 2, title: englishOnly('C') }),
      collection({ slug: 'a', position: 0, title: englishOnly('A') }),
      collection({ slug: 'b', position: 1, title: englishOnly('B') }),
    ];
    const { repo } = collectionRepo(null, unsorted);
    const result = await makeListCollections({ repository: repo, storeId: 'taz4tech' })();
    expect(result.map((c) => c.slug)).toEqual(['a', 'b', 'c']);
  });
});

describe('getCollectionProducts', () => {
  const products = (repo: ProductRepository) =>
    makeGetCollectionProducts({ repository: repo, storeId: 'taz4tech' });

  it('passes the collection rules as MEMBERSHIP, not as filters', async () => {
    // The distinction is the whole design: membership is `rules OR pinned`,
    // customer filters are ANDed on top.
    const { repo, calls } = productRepo();
    await products(repo)(collection({ rules: { brands: ['Lenovo'] } }));

    expect(calls[0]?.membership?.rules.brands).toEqual(['Lenovo']);
    expect(calls[0]?.filters.brands).toBeUndefined();
  });

  it('passes pinned ids as part of membership', async () => {
    const { repo, calls } = productRepo();
    await products(repo)(collection({ pinnedProductIds: [pid(1), pid(2)] }));
    expect(calls[0]?.membership?.pinnedProductIds).toEqual([pid(1), pid(2)]);
  });

  it('keeps the customer filters separate from membership', async () => {
    // A pinned Dell must not survive a "Lenovo only" filter, which only works
    // if the two stay in different clauses.
    const { repo, calls } = productRepo();
    await products(repo)(collection({ pinnedProductIds: [pid(1)] }), { brands: ['Lenovo'] });

    expect(calls[0]?.membership?.pinnedProductIds).toEqual([pid(1)]);
    expect(calls[0]?.filters.brands).toEqual(['Lenovo']);
  });

  it('forwards a search within the collection', async () => {
    const { repo, calls } = productRepo();
    await products(repo)(collection(), { search: 'laptop' });
    expect(calls[0]?.filters.search).toBe('laptop');
  });

  it('forwards a price rule from the collection and a price filter from the customer', async () => {
    const { repo, calls } = productRepo();
    await products(repo)(collection({ rules: { priceMinCents: 1000, priceMaxCents: 9000 } }), {
      priceMinCents: 2000,
    });
    expect(calls[0]?.membership?.rules.priceMinCents).toBe(1000);
    expect(calls[0]?.membership?.rules.priceMaxCents).toBe(9000);
    expect(calls[0]?.filters.priceMinCents).toBe(2000);
  });

  it('forwards option rules', async () => {
    const { repo, calls } = productRepo();
    await products(repo)(
      collection({ rules: { options: [{ name: 'Colour', values: ['Black'] }] } }),
    );
    expect(calls[0]?.membership?.rules.options).toEqual([{ name: 'Colour', values: ['Black'] }]);
  });

  it('restricts to active products by default', async () => {
    const { repo, calls } = productRepo();
    await products(repo)(collection());
    expect(calls[0]?.status).toBe('active');
  });

  it('includes unpublished for an admin caller', async () => {
    const { repo, calls } = productRepo();
    await products(repo)(collection(), { includeUnpublished: true });
    expect(calls[0]?.status).toBeUndefined();
  });

  it('forwards a cursor', async () => {
    const { repo, calls } = productRepo();
    await products(repo)(collection(), { cursor: 'abc' });
    expect(calls[0]?.cursor).toBe('abc');
  });

  it.each([1, MAX_PAGE_SIZE])('accepts a limit of exactly %s', async (limit) => {
    // The ends of the range every rejection test steps past.
    const { repo, calls } = productRepo();
    const result = await products(repo)(collection(), { limit });

    expect(result.ok).toBe(true);
    expect(calls[0]?.limit).toBe(limit);
  });

  it.each([0, -1, 1.5, MAX_PAGE_SIZE + 1, Number.NaN])(
    'rejects a limit of %s without querying',
    async (limit) => {
      const { repo, calls } = productRepo();
      const result = await products(repo)(collection(), { limit });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('invalid_limit');
      expect(calls).toHaveLength(0);
    },
  );

  it('lets a repository failure propagate', async () => {
    const repo: ProductRepository = {
      findBySlug: vi.fn(),
      findById: vi.fn(),
      findBySku: vi.fn(),
      findBySlugs: vi.fn(),
      findBySkus: vi.fn(async () => []),
      findByIds: vi.fn(async () => []),
      list: vi.fn(),
      save: vi.fn(),
      search: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    await expect(products(repo)(collection())).rejects.toThrow('connection refused');
  });
});
