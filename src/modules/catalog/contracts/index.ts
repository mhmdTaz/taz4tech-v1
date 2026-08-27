/**
 * Ports for the catalogue. Infrastructure implements these; the application
 * layer depends only on them.
 */

import type { Result } from '@platform/result';
import type { Collection, CollectionId, CollectionStatus } from '../domain/collection';
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

/**
 * A collection's membership clause.
 *
 * `(matches the rules) OR (is pinned)`. It is a separate parameter from
 * `filters` precisely because the two combine differently: membership is ORed
 * internally and then ANDed with whatever the customer filtered, so a pinned
 * product cannot survive a filter it does not match.
 */
export type MembershipClause = {
  readonly rules: ProductFilters;
  readonly pinnedProductIds: readonly ProductId[];
};

export type SearchProductsQuery = ListProductsQuery & {
  readonly filters: ProductFilters;
  readonly membership?: MembershipClause;
  /** Pinned-first ordering, for a curated collection. */
  readonly pinnedFirst?: readonly ProductId[];
};

export type SearchResult = ProductPage & {
  readonly facets: Facets;
};

export type ListCollectionsQuery = {
  readonly storeId: string;
  readonly status?: CollectionStatus;
};

export interface CollectionRepository {
  findBySlug(storeId: string, slug: string): Promise<Collection | null>;
  findById(storeId: string, id: CollectionId): Promise<Collection | null>;
  /** Navigation order, already sorted. */
  list(query: ListCollectionsQuery): Promise<Collection[]>;
  save(collection: Collection): Promise<void>;
}

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
  /**
   * Bulk SKU lookup, so an import can see a SKU already owned by ANOTHER product
   * before it tries to write one.
   *
   * A SKU is unique across the store, but a sheet identifies a product by slug.
   * Rename a product and re-list its SKU and the two disagree — the planner
   * calls it a create, and the unique index rejects the write. Without this
   * lookup that only surfaces as a failed write, halfway through the import.
   */
  findBySkus(storeId: string, skus: readonly string[]): Promise<Product[]>;
  /**
   * Bulk id lookup, for an admin acting on an explicit selection.
   *
   * Returns only what exists and only within the store, so an id from another
   * tenant is simply absent rather than an error — and the caller reports the
   * absence rather than quietly acting on a shorter list than it was given.
   */
  findByIds(storeId: string, ids: readonly ProductId[]): Promise<Product[]>;
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
  /**
   * Write a product.
   *
   * Returns a Result rather than throwing on a uniqueness conflict, because a
   * conflict is an EXPECTED outcome of importing a spreadsheet someone else may
   * also be editing — not a bug. Anything else (a dropped connection, a bad
   * write concern) still throws.
   */
  save(product: Product): Promise<Result<void, SaveConflict>>;
}

/**
 * Somewhere to put the stock column of a catalogue spreadsheet.
 *
 * Stock is a separate document in a separate module, and the catalogue has no
 * business knowing how it is stored. It arrives in the same file because that is
 * how a supplier sends a price list — asking an operator to maintain two files
 * describing one delivery is asking them to keep one of them wrong.
 *
 * So: the catalogue owns this INTERFACE, the composition root wires the
 * inventory module into it, and neither module imports the other.
 */
export type StockWriteFailure = { readonly sku: string; readonly reason: string };

export interface StockWriter {
  /** Returns only what it could not write; an empty array means all of it landed. */
  setLevels(
    levels: readonly { readonly sku: string; readonly onHand: number }[],
  ): Promise<readonly StockWriteFailure[]>;
}

/** A unique index refused the write. Which one is what the caller has to report. */
export type SaveConflict =
  | { readonly tag: 'sku_taken'; readonly sku: string }
  | { readonly tag: 'slug_taken'; readonly slug: string };
