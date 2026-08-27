import { describe, expect, it, vi } from 'vitest';
import type { ListProductsQuery, ProductRepository } from '../contracts';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, makeListProducts } from './list-products';

const repository = () => {
  const calls: ListProductsQuery[] = [];
  const repo: ProductRepository = {
    findBySlug: vi.fn(),
    findById: vi.fn(),
    findBySku: vi.fn(),
    save: vi.fn(),
    list: vi.fn(async (query: ListProductsQuery) => {
      calls.push(query);
      return { products: [], nextCursor: null };
    }),
  };
  return { repo, calls };
};

const listFor = (repo: ProductRepository) =>
  makeListProducts({ repository: repo, storeId: 'taz4tech' });

describe('listProducts', () => {
  it('uses the default page size when none is given', async () => {
    const { repo, calls } = repository();
    await listFor(repo)();
    expect(calls[0]?.limit).toBe(DEFAULT_PAGE_SIZE);
  });

  it('queries only the tenant it was wired with', async () => {
    const { repo, calls } = repository();
    await listFor(repo)();
    expect(calls[0]?.storeId).toBe('taz4tech');
  });

  it('passes a valid limit through', async () => {
    const { repo, calls } = repository();
    await listFor(repo)({ limit: 12 });
    expect(calls[0]?.limit).toBe(12);
  });

  it('accepts the boundary page sizes', async () => {
    const { repo } = repository();
    expect((await listFor(repo)({ limit: 1 })).ok).toBe(true);
    expect((await listFor(repo)({ limit: MAX_PAGE_SIZE })).ok).toBe(true);
  });

  it.each([0, -1, 1.5, MAX_PAGE_SIZE + 1, 100_000, Number.NaN])(
    'rejects a limit of %s rather than silently clamping it',
    async (limit) => {
      const { repo, calls } = repository();
      const result = await listFor(repo)({ limit });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('invalid_limit');
      // The repository is never reached, so a bad page size cannot cost a query.
      expect(calls).toHaveLength(0);
    },
  );

  it('filters to active products by default', async () => {
    const { repo, calls } = repository();
    await listFor(repo)();
    expect(calls[0]?.status).toBe('active');
  });

  it('cannot be tricked into returning drafts via the status parameter alone', async () => {
    // The single gate is includeUnpublished. If `status` could also widen
    // visibility there would be two ways to leak unpublished products, and the
    // caller who finds the second one is never the one who read this file.
    const { repo, calls } = repository();
    await listFor(repo)({ status: 'draft' });
    expect(calls[0]?.status).toBe('active');

    await listFor(repo)({ status: 'archived' });
    expect(calls[1]?.status).toBe('active');
  });

  it('returns every status for an admin caller that asks for it', async () => {
    const { repo, calls } = repository();
    await listFor(repo)({ includeUnpublished: true });
    expect(calls[0]?.status).toBeUndefined();
  });

  it('lets an admin caller filter to one status', async () => {
    const { repo, calls } = repository();
    await listFor(repo)({ includeUnpublished: true, status: 'draft' });
    expect(calls[0]?.status).toBe('draft');
  });

  it('forwards a cursor when given, and omits the key when not', async () => {
    const { repo, calls } = repository();
    await listFor(repo)({ cursor: 'abc' });
    expect(calls[0]?.cursor).toBe('abc');

    await listFor(repo)();
    expect(Object.hasOwn(calls[1] ?? {}, 'cursor')).toBe(false);
  });

  it('returns the page the repository produced', async () => {
    const repo: ProductRepository = {
      findBySlug: vi.fn(),
      findById: vi.fn(),
      findBySku: vi.fn(),
      save: vi.fn(),
      list: vi.fn().mockResolvedValue({ products: [], nextCursor: 'next-page' }),
    };
    const result = await listFor(repo)();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.nextCursor).toBe('next-page');
  });

  it('lets a repository failure propagate rather than reporting an empty page', async () => {
    const repo: ProductRepository = {
      findBySlug: vi.fn(),
      findById: vi.fn(),
      findBySku: vi.fn(),
      save: vi.fn(),
      list: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    // An empty catalogue and an unreachable database must not look the same.
    await expect(listFor(repo)()).rejects.toThrow('connection refused');
  });
});
