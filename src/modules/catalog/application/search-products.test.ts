import { describe, expect, it, vi } from 'vitest';
import type { ProductRepository, SearchProductsQuery } from '../contracts';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './list-products';
import { MAX_FILTER_VALUES, makeSearchProducts } from './search-products';

const emptyResult = {
  products: [],
  nextCursor: null,
  facets: { brands: [], options: [], priceRange: null },
};

const repository = () => {
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
      return emptyResult;
    }),
  };
  return { repo, calls };
};

const search = (repo: ProductRepository) =>
  makeSearchProducts({ repository: repo, storeId: 'taz4tech' });

describe('searchProducts', () => {
  it('defaults to the standard page size and active products only', async () => {
    const { repo, calls } = repository();
    await search(repo)();
    expect(calls[0]?.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(calls[0]?.status).toBe('active');
    expect(calls[0]?.storeId).toBe('taz4tech');
  });

  it.each([0, -1, 1.5, MAX_PAGE_SIZE + 1, Number.NaN])('rejects a limit of %s', async (limit) => {
    const { repo, calls } = repository();
    const result = await search(repo)({ limit });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('invalid_limit');
    expect(calls).toHaveLength(0);
  });

  describe('unpublished products', () => {
    it('cannot be reached without the single gate', async () => {
      const { repo, calls } = repository();
      await search(repo)({ search: 'anything' });
      expect(calls[0]?.status).toBe('active');
    });

    it('are included for an admin caller', async () => {
      const { repo, calls } = repository();
      await search(repo)({ includeUnpublished: true });
      expect(calls[0]?.status).toBeUndefined();
    });
  });

  describe('search terms', () => {
    it('passes a real query through', async () => {
      const { repo, calls } = repository();
      await search(repo)({ search: 'laptop' });
      expect(calls[0]?.filters.search).toBe('laptop');
    });

    it('drops a query that is only whitespace', async () => {
      // Passing it through costs a text-index lookup that can only return
      // nothing.
      const { repo, calls } = repository();
      await search(repo)({ search: '   ' });
      expect(calls[0]?.filters.search).toBeUndefined();
    });

    it('keeps an Arabic query', async () => {
      const { repo, calls } = repository();
      await search(repo)({ search: 'لابتوب' });
      expect(calls[0]?.filters.search).toBe('لابتوب');
    });
  });

  describe('filters', () => {
    it('forwards brands, de-duplicated', async () => {
      const { repo, calls } = repository();
      await search(repo)({ brands: ['Lenovo', 'Dell', 'Lenovo'] });
      expect(calls[0]?.filters.brands).toEqual(['Lenovo', 'Dell']);
    });

    it('drops blank brand values rather than filtering on nothing', async () => {
      const { repo, calls } = repository();
      await search(repo)({ brands: ['Lenovo', '  '] });
      expect(calls[0]?.filters.brands).toEqual(['Lenovo']);
    });

    it('omits the brands key entirely when none survive', async () => {
      const { repo, calls } = repository();
      await search(repo)({ brands: ['   '] });
      expect(calls[0]?.filters.brands).toBeUndefined();
    });

    it('forwards option selections', async () => {
      const { repo, calls } = repository();
      await search(repo)({ options: [{ name: 'Colour', values: ['Black', 'Silver'] }] });
      expect(calls[0]?.filters.options).toEqual([{ name: 'Colour', values: ['Black', 'Silver'] }]);
    });

    it('drops an option with no values left', async () => {
      const { repo, calls } = repository();
      await search(repo)({ options: [{ name: 'Colour', values: [] }] });
      expect(calls[0]?.filters.options).toBeUndefined();
    });

    it('refuses an absurd number of filter values', async () => {
      // A crafted URL, not a customer.
      const { repo, calls } = repository();
      const many = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => `brand-${i}`);
      const result = await search(repo)({ brands: many });

      expect(result).toMatchObject({
        ok: false,
        error: { tag: 'too_many_filter_values', field: 'brands' },
      });
      expect(calls).toHaveLength(0);
    });

    it('refuses too many values on a single option', async () => {
      const { repo } = repository();
      const values = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => `v${i}`);
      const result = await search(repo)({ options: [{ name: 'Colour', values }] });
      expect(result).toMatchObject({
        ok: false,
        error: { tag: 'too_many_filter_values', field: 'Colour' },
      });
    });

    it('refuses too many option axes', async () => {
      const { repo } = repository();
      const options = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => ({
        name: `opt${i}`,
        values: ['x'],
      }));
      const result = await search(repo)({ options });
      expect(result).toMatchObject({
        ok: false,
        error: { tag: 'too_many_filter_values', field: 'options' },
      });
    });
  });

  describe('price range', () => {
    it('forwards both bounds', async () => {
      const { repo, calls } = repository();
      await search(repo)({ priceMinCents: 1000, priceMaxCents: 5000 });
      expect(calls[0]?.filters.priceMinCents).toBe(1000);
      expect(calls[0]?.filters.priceMaxCents).toBe(5000);
    });

    it('accepts an open-ended range', async () => {
      const { repo, calls } = repository();
      await search(repo)({ priceMinCents: 1000 });
      expect(calls[0]?.filters.priceMinCents).toBe(1000);
      expect(calls[0]?.filters.priceMaxCents).toBeUndefined();
    });

    it('truncates a fractional cent rather than passing it on', async () => {
      const { repo, calls } = repository();
      await search(repo)({ priceMinCents: 10.7 });
      expect(calls[0]?.filters.priceMinCents).toBe(10);
    });

    it('refuses a reversed range instead of quietly swapping it', async () => {
      // A reversed range means the UI or the link is wrong; correcting it
      // silently hides that from whoever built it.
      const { repo, calls } = repository();
      const result = await search(repo)({ priceMinCents: 5000, priceMaxCents: 1000 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('invalid_price_range');
      expect(calls).toHaveLength(0);
    });

    it('refuses a negative minimum', async () => {
      const { repo } = repository();
      const result = await search(repo)({ priceMinCents: -1 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('invalid_price_range');
    });

    it('ignores a non-finite bound', async () => {
      const { repo, calls } = repository();
      await search(repo)({ priceMinCents: Number.NaN });
      expect(calls[0]?.filters.priceMinCents).toBeUndefined();
    });
  });

  it('forwards a cursor when given', async () => {
    const { repo, calls } = repository();
    await search(repo)({ cursor: 'abc' });
    expect(calls[0]?.cursor).toBe('abc');
  });

  it('returns the facets the repository produced', async () => {
    const { repo } = repository();
    const result = await search(repo)();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.facets).toEqual(emptyResult.facets);
  });

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
    await expect(search(repo)()).rejects.toThrow('connection refused');
  });
});

describe('the status gate', () => {
  const queryFor = async (input: Parameters<ReturnType<typeof search>>[0]) => {
    const { repo, calls } = repository();
    await search(repo)(input);
    return calls[0];
  };

  it('forces active for a storefront caller', async () => {
    expect(await queryFor({})).toMatchObject({ status: 'active' });
  });

  it('ignores an explicit status unless unpublished are asked for', async () => {
    // The gate that matters: ?status=draft on a storefront URL must not become
    // a draft listing. There is one way to widen visibility, not two.
    expect(await queryFor({ status: 'draft' })).toMatchObject({ status: 'active' });
  });

  it('drops the status filter entirely for an admin caller', async () => {
    expect(await queryFor({ includeUnpublished: true })).not.toHaveProperty('status');
  });

  it('honours a status for an admin caller', async () => {
    expect(await queryFor({ includeUnpublished: true, status: 'draft' })).toMatchObject({
      status: 'draft',
    });
  });
});
