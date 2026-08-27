/**
 * Use case: write a collection.
 *
 * Same shape as saveProduct — tenant checked before validation, and a
 * slug clash reported by name rather than surfaced as a driver error.
 */

import { err, ok, type Result } from '@platform/result';
import type { CollectionRepository, ProductRepository } from '../contracts';
import { type Collection, type CollectionError, createCollection } from '../domain/collection';
import type { ProductId } from '../domain/product';

export type SaveCollectionError =
  | { readonly tag: 'invalid'; readonly reason: CollectionError }
  | { readonly tag: 'wrong_tenant'; readonly expected: string; readonly received: string }
  | { readonly tag: 'slug_taken'; readonly slug: string }
  | { readonly tag: 'pinned_product_missing'; readonly productId: ProductId };

export type SaveCollection = (
  input: Collection,
) => Promise<Result<Collection, SaveCollectionError>>;

export const makeSaveCollection =
  (deps: {
    repository: CollectionRepository;
    products: ProductRepository;
    storeId: string;
  }): SaveCollection =>
  async (input) => {
    if (input.storeId !== deps.storeId) {
      return err({ tag: 'wrong_tenant', expected: deps.storeId, received: input.storeId });
    }

    const collection = createCollection(input);
    if (!collection.ok) return err({ tag: 'invalid', reason: collection.error });

    const existing = await deps.repository.findBySlug(deps.storeId, collection.value.slug);
    if (existing !== null && existing.id !== collection.value.id) {
      return err({ tag: 'slug_taken', slug: collection.value.slug });
    }

    /*
     * Pinned ids are checked to exist.
     *
     * A dangling id is silent: the collection simply shows one product fewer
     * than the curator arranged, with nothing anywhere saying why. Checking on
     * write turns that into an error naming the id, at the moment someone can
     * still do something about it.
     */
    for (const productId of collection.value.pinnedProductIds) {
      const product = await deps.products.findById(deps.storeId, productId);
      if (product === null) return err({ tag: 'pinned_product_missing', productId });
    }

    await deps.repository.save(collection.value);
    return ok(collection.value);
  };
