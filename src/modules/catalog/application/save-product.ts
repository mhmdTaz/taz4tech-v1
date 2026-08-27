/**
 * Use case: write a product.
 *
 * Used by the seeder now and by the Excel importer next. It takes raw input and
 * validates here, once, on the way in — a caller cannot skip validation by
 * constructing the object itself, because createProduct is the only way to
 * obtain a Product.
 */

import { err, ok, type Result } from '@platform/result';
import type { ProductRepository } from '../contracts';
import { createProduct, type Product, type ProductError } from '../domain/product';

export type SaveProductError =
  | { readonly tag: 'invalid'; readonly reason: ProductError }
  | { readonly tag: 'wrong_tenant'; readonly expected: string; readonly received: string }
  | { readonly tag: 'slug_taken'; readonly slug: string }
  | { readonly tag: 'sku_taken'; readonly sku: string };

export type SaveProduct = (input: Product) => Promise<Result<Product, SaveProductError>>;

export const makeSaveProduct =
  (deps: { repository: ProductRepository; storeId: string; now: () => Date }): SaveProduct =>
  async (input) => {
    if (input.storeId !== deps.storeId) {
      return err({ tag: 'wrong_tenant', expected: deps.storeId, received: input.storeId });
    }

    const product = createProduct(input, deps.now());
    if (!product.ok) return err({ tag: 'invalid', reason: product.error });

    /*
     * Checked here as well as by the unique index, because the two answer
     * different questions. The index guarantees the constraint; this check
     * turns "E11000 duplicate key" into an error naming the slug, which is what
     * an importer has to show against row 412 of a spreadsheet.
     */
    const existing = await deps.repository.findBySlug(deps.storeId, product.value.slug);
    if (existing !== null && existing.id !== product.value.id) {
      return err({ tag: 'slug_taken', slug: product.value.slug });
    }

    /*
     * The repository's answer is not discarded.
     *
     * save() reports a uniqueness conflict rather than throwing, so ignoring it
     * would turn a refused write into a reported success — the worst possible
     * shape for this function, because the caller would go on to tell someone
     * the product was saved. The slug check above catches the common case
     * early; this catches the SKU, and catches a slug taken in the moment
     * between that read and this write.
     */
    const saved = await deps.repository.save(product.value);
    if (!saved.ok) return err(saved.error);

    return ok(product.value);
  };
