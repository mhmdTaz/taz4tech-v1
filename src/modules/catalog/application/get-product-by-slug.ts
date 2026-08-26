/**
 * Use case: read one product for a product page.
 *
 * This is the layer carrying genuine 100% coverage, because the Server Component
 * that renders it cannot be unit tested. Every decision about what a customer is
 * allowed to see lives here.
 */

import { err, ok, type Result } from '@platform/result';
import type { ProductRepository } from '../contracts';
import { isPurchasable, type Product } from '../domain/product';

export type GetProductBySlugError =
  | { readonly tag: 'not_found'; readonly slug: string }
  | { readonly tag: 'not_available'; readonly slug: string };

export type GetProductBySlug = (
  slug: string,
  options?: { readonly includeUnpublished?: boolean },
) => Promise<Result<Product, GetProductBySlugError>>;

export const makeGetProductBySlug =
  (deps: { repository: ProductRepository; storeId: string }): GetProductBySlug =>
  async (slug, options) => {
    const normalized = slug.trim().toLowerCase();
    if (normalized.length === 0) return err({ tag: 'not_found', slug });

    const product = await deps.repository.findBySlug(deps.storeId, normalized);
    if (product === null) return err({ tag: 'not_found', slug: normalized });

    /*
     * A draft or archived product is reported as `not_available`, distinct from
     * `not_found`, so the delivery layer can choose: the storefront renders 404
     * for both, but the admin preview needs to show a draft. Collapsing them
     * here would make previewing an unpublished product impossible without a
     * second query path.
     */
    if (!isPurchasable(product) && options?.includeUnpublished !== true) {
      return err({ tag: 'not_available', slug: normalized });
    }

    return ok(product);
  };
