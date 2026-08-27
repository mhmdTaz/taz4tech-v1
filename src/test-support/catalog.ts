import type { ProductRepository } from '@modules/catalog';
import { ok } from '@platform/result';
import { vi } from 'vitest';

/**
 * A complete ProductRepository of stubs, for tests that only care about one or
 * two of its methods.
 *
 * Written after adding a third method to the port and having to patch the same
 * hand-rolled object in eight test files. Each of those was a place where the
 * compiler said "you forgot findByIds" about a method the test does not use and
 * will never call — noise that hides the one file where the omission matters.
 *
 * The defaults are the SAFE answers: nothing found, nothing conflicting. A test
 * that needs different behaviour passes it in, which then reads as the point of
 * that test rather than as boilerplate.
 */
export const fakeProductRepository = (
  overrides: Partial<ProductRepository> = {},
): ProductRepository => ({
  findBySlug: vi.fn(async () => null),
  findById: vi.fn(async () => null),
  findBySku: vi.fn(async () => null),
  findBySlugs: vi.fn(async () => []),
  findBySkus: vi.fn(async () => []),
  findByIds: vi.fn(async () => []),
  list: vi.fn(async () => ({ products: [], nextCursor: null })),
  search: vi.fn(async () => ({
    products: [],
    nextCursor: null,
    facets: { brands: [], options: [], priceRange: null },
  })),
  save: vi.fn(async () => ok(undefined)),
  ...overrides,
});
