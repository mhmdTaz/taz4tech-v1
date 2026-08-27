/**
 * Use case: list products for a listing page.
 *
 * The page-size clamp lives here rather than in the route handler because the
 * limit arrives from a query string a customer controls. `?limit=100000` in the
 * delivery layer is a request; here it is a bounded number.
 */

import { err, ok, type Result } from '@platform/result';
import type { ProductPage, ProductRepository } from '../contracts';
import type { ProductStatus } from '../domain/product';

export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 60;

export type ListProductsError = { readonly tag: 'invalid_limit'; readonly limit: number };

export type ListProductsInput = {
  readonly limit?: number;
  readonly cursor?: string;
  /** Storefront callers leave this alone; the admin passes a status to filter by. */
  readonly status?: ProductStatus;
  /** Admin-only. The storefront must never see drafts. */
  readonly includeUnpublished?: boolean;
};

export type ListProducts = (
  input?: ListProductsInput,
) => Promise<Result<ProductPage, ListProductsError>>;

export const makeListProducts =
  (deps: { repository: ProductRepository; storeId: string }): ListProducts =>
  async (input = {}) => {
    const requested = input.limit ?? DEFAULT_PAGE_SIZE;

    // Rejected rather than clamped: silently returning 24 rows for ?limit=0
    // makes a broken caller look like a working one.
    if (!Number.isInteger(requested) || requested < 1 || requested > MAX_PAGE_SIZE) {
      return err({ tag: 'invalid_limit', limit: requested });
    }

    /*
     * Unpublished products are gated on ONE flag, and `status` cannot be used to
     * reach around it — `list({ status: 'draft' })` still returns nothing but
     * active products unless includeUnpublished is set.
     *
     * Two independent ways to widen visibility is one too many: the caller who
     * leaks drafts to customers is never the one who read this file, it is the
     * one who passed the parameter that looked harmless.
     */
    const status: ProductStatus | undefined =
      input.includeUnpublished === true ? input.status : 'active';

    return ok(
      await deps.repository.list({
        storeId: deps.storeId,
        limit: requested,
        ...(status === undefined ? {} : { status }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }),
    );
  };
