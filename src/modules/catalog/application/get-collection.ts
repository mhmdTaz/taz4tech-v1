/**
 * Use cases for reading collections.
 *
 * The interesting one is getCollectionProducts: it turns a collection into a
 * search, so a collection page gets the same facets, search box and pagination
 * as the main listing rather than a second implementation of them.
 */

import { compact } from '@platform/object';
import { err, ok, type Result } from '@platform/result';
import type {
  CollectionRepository,
  MembershipClause,
  ProductRepository,
  SearchResult,
} from '../contracts';
import { type Collection, compareForNavigation, isPublished } from '../domain/collection';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './list-products';
import type { SearchProductsInput } from './search-products';

export type GetCollectionError =
  | { readonly tag: 'not_found'; readonly slug: string }
  | { readonly tag: 'not_available'; readonly slug: string };

export type GetCollection = (
  slug: string,
  options?: { readonly includeUnpublished?: boolean },
) => Promise<Result<Collection, GetCollectionError>>;

export const makeGetCollection =
  (deps: { repository: CollectionRepository; storeId: string }): GetCollection =>
  async (slug, options) => {
    const normalized = slug.trim().toLowerCase();
    if (normalized.length === 0) return err({ tag: 'not_found', slug });

    const collection = await deps.repository.findBySlug(deps.storeId, normalized);
    if (collection === null) return err({ tag: 'not_found', slug: normalized });

    // Same distinction as products: the storefront 404s on both, the admin
    // preview needs to tell a draft from something that does not exist.
    if (!isPublished(collection) && options?.includeUnpublished !== true) {
      return err({ tag: 'not_available', slug: normalized });
    }

    return ok(collection);
  };

export type ListCollections = (options?: {
  readonly includeUnpublished?: boolean;
}) => Promise<Collection[]>;

export const makeListCollections =
  (deps: { repository: CollectionRepository; storeId: string }): ListCollections =>
  async (options) =>
    (
      await deps.repository.list({
        storeId: deps.storeId,
        // The single gate again: unpublished collections are opt-in only.
        ...(options?.includeUnpublished === true ? {} : { status: 'active' as const }),
      })
    ).sort(compareForNavigation);

export type GetCollectionProductsError = { readonly tag: 'invalid_limit'; readonly limit: number };

export type GetCollectionProducts = (
  collection: Collection,
  input?: SearchProductsInput,
) => Promise<Result<SearchResult, GetCollectionProductsError>>;

/**
 * The products of a collection, filtered further by whatever the customer chose.
 *
 * Membership and customer filters are deliberately separate arguments. Membership
 * is `rules OR pinned`; the customer's choices are ANDed on top. Merging them
 * into one filter object would let a pinned product survive a filter it does not
 * match — a pinned Dell showing up under "Lenovo only".
 */
export const makeGetCollectionProducts =
  (deps: { repository: ProductRepository; storeId: string }): GetCollectionProducts =>
  async (collection, input = {}) => {
    const limit = input.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      return err({ tag: 'invalid_limit', limit });
    }

    const membership: MembershipClause = {
      rules: compact({
        brands: collection.rules.brands,
        options: collection.rules.options,
        priceMinCents: collection.rules.priceMinCents,
        priceMaxCents: collection.rules.priceMaxCents,
      }),
      pinnedProductIds: collection.pinnedProductIds,
    };

    return ok(
      await deps.repository.search(
        compact({
          storeId: deps.storeId,
          limit,
          status: input.includeUnpublished === true ? undefined : ('active' as const),
          cursor: input.cursor,
          membership,
          filters: compact({
            search: input.search,
            brands: input.brands,
            options: input.options,
            priceMinCents: input.priceMinCents,
            priceMaxCents: input.priceMaxCents,
          }),
        }),
      ),
    );
  };
