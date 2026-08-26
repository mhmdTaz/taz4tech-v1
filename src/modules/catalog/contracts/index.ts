/**
 * Ports for the catalogue. Infrastructure implements these; the application
 * layer depends only on them.
 */

import type { Product, ProductId, ProductStatus } from '../domain/product';

export type ProductPage = {
  readonly products: readonly Product[];
  /**
   * Opaque cursor for the next page, or null at the end.
   *
   * Cursor rather than offset because a customer browsing page 4 while a product
   * is published would otherwise see an item shift across the boundary — either
   * duplicated or skipped. Skip/limit gets slower with depth too.
   */
  readonly nextCursor: string | null;
};

export type ListProductsQuery = {
  readonly storeId: string;
  /** Omit to include every status. The storefront always passes 'active'. */
  readonly status?: ProductStatus;
  readonly limit: number;
  readonly cursor?: string;
};

export interface ProductRepository {
  findBySlug(storeId: string, slug: string): Promise<Product | null>;
  findById(storeId: string, id: ProductId): Promise<Product | null>;
  /** Lookup by any variant's SKU — the importer uses it to decide insert vs update. */
  findBySku(storeId: string, sku: string): Promise<Product | null>;
  list(query: ListProductsQuery): Promise<ProductPage>;
  save(product: Product): Promise<void>;
}
