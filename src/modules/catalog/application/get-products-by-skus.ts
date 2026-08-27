/**
 * Use case: the products behind a set of SKUs.
 *
 * Written for the cart, which knows SKUs and nothing else — the cookie holds a
 * variant identifier and no prices, precisely so that every amount is read from
 * here at render time rather than from something the customer can edit.
 *
 * Storefront callers get ACTIVE products only, through the same single gate the
 * listing uses. A product archived while a cart sat open must stop being
 * purchasable, and it stops here rather than in whatever renders it.
 */

import type { ProductRepository } from '../contracts';
import type { Product } from '../domain/product';

/** A cart cannot hold more lines than this, so neither can one lookup. */
export const MAX_SKU_LOOKUP = 100;

export type GetProductsBySkusInput = {
  readonly skus: readonly string[];
  /** Admin only. The storefront must never price a draft. */
  readonly includeUnpublished?: boolean;
};

/** SKU -> the product that owns it. A SKU that resolves to nothing is absent. */
export type GetProductsBySkus = (
  input: GetProductsBySkusInput,
) => Promise<ReadonlyMap<string, Product>>;

export const makeGetProductsBySkus =
  (deps: { repository: ProductRepository; storeId: string }): GetProductsBySkus =>
  async (input) => {
    const skus = [...new Set(input.skus.filter((sku) => sku.trim().length > 0))].slice(
      0,
      MAX_SKU_LOOKUP,
    );
    if (skus.length === 0) return new Map();

    const products = await deps.repository.findBySkus(deps.storeId, skus);

    const bySku = new Map<string, Product>();
    for (const product of products) {
      // The single gate again. A caller cannot reach around it by asking for a
      // SKU directly — which is exactly how a draft would end up in a cart.
      if (product.status !== 'active' && input.includeUnpublished !== true) continue;

      for (const variant of product.variants) {
        // Only the SKUs that were ASKED for. A multi-variant product comes back
        // whole, and indexing every one of its SKUs would let a cart line for a
        // variant nobody requested resolve.
        if (skus.includes(variant.sku)) bySku.set(variant.sku, product);
      }
    }

    return bySku;
  };
