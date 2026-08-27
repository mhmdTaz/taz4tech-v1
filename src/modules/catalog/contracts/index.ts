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

/** A facet value and how many products carry it. */
export type FacetValue = {
  readonly value: string;
  readonly count: number;
};

export type OptionFacet = {
  readonly name: string;
  readonly values: readonly FacetValue[];
};

export type Facets = {
  readonly brands: readonly FacetValue[];
  readonly options: readonly OptionFacet[];
  /** Null when nothing matched, so the price slider has nothing to bound. */
  readonly priceRange: { readonly minCents: number; readonly maxCents: number } | null;
};

export type ProductFilters = {
  /** Raw customer input; the repository expands and normalises it. */
  readonly search?: string;
  readonly brands?: readonly string[];
  readonly options?: readonly { readonly name: string; readonly values: readonly string[] }[];
  readonly priceMinCents?: number;
  readonly priceMaxCents?: number;
};

export type SearchProductsQuery = ListProductsQuery & {
  readonly filters: ProductFilters;
};

export type SearchResult = ProductPage & {
  readonly facets: Facets;
};

/**
 * Reads a spreadsheet into rows of text.
 *
 * A port rather than a direct call, so the import engine never depends on a file
 * format. Every cell arrives as a string — including dates, normalised to ISO by
 * the adapter — which is what lets the engine be tested with plain arrays
 * instead of binary fixtures nobody can review in a diff.
 */
export interface WorkbookReader {
  readRows(file: Uint8Array): Promise<string[][]>;
}

export interface ProductRepository {
  findBySlug(storeId: string, slug: string): Promise<Product | null>;
  findById(storeId: string, id: ProductId): Promise<Product | null>;
  /** Lookup by any variant's SKU — the importer uses it to decide insert vs update. */
  findBySku(storeId: string, sku: string): Promise<Product | null>;
  /**
   * Bulk slug lookup, for the importer's create-vs-update decision.
   *
   * One query for four hundred slugs rather than four hundred queries. At a
   * round trip each to Atlas, the difference is a preview that appears versus
   * one that times out.
   */
  findBySlugs(storeId: string, slugs: readonly string[]): Promise<Product[]>;
  list(query: ListProductsQuery): Promise<ProductPage>;
  /**
   * A page of results plus the facet counts for the same query.
   *
   * One aggregation, not one query per facet. Each facet's counts deliberately
   * IGNORE that facet's own selection — otherwise choosing "Lenovo" collapses
   * the brand list to Lenovo alone and the customer cannot switch to Dell
   * without clearing the filter first.
   */
  search(query: SearchProductsQuery): Promise<SearchResult>;
  save(product: Product): Promise<void>;
}
