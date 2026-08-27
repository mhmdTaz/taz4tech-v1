/**
 * Use case: a filtered, faceted page of products.
 *
 * Everything here arrives from a query string a customer controls, so this is
 * the layer that bounds it. `?limit=100000`, forty brand filters and a negative
 * price are requests in the delivery layer; here they are bounded numbers or
 * refusals.
 */

import { compact } from '@platform/object';
import { err, ok, type Result } from '@platform/result';
import type { ProductFilters, ProductRepository, SearchResult } from '../contracts';
import { isSearchable } from '../domain/search';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './list-products';

/** More facet selections than this is a crafted URL, not a customer. */
export const MAX_FILTER_VALUES = 20;

export type SearchProductsError =
  | { readonly tag: 'invalid_limit'; readonly limit: number }
  | { readonly tag: 'too_many_filter_values'; readonly field: string }
  | { readonly tag: 'invalid_price_range'; readonly minCents: number; readonly maxCents: number };

export type SearchProductsInput = {
  readonly limit?: number;
  readonly cursor?: string;
  readonly search?: string;
  readonly brands?: readonly string[];
  readonly options?: readonly { readonly name: string; readonly values: readonly string[] }[];
  readonly priceMinCents?: number;
  readonly priceMaxCents?: number;
  /** Admin only. The storefront must never see drafts. */
  readonly includeUnpublished?: boolean;
};

export type SearchProducts = (
  input?: SearchProductsInput,
) => Promise<Result<SearchResult, SearchProductsError>>;

const boundedInteger = (value: number | undefined): number | undefined =>
  value === undefined || !Number.isFinite(value) ? undefined : Math.trunc(value);

const validateLimit = (limit: number): SearchProductsError | null =>
  Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE_SIZE
    ? null
    : { tag: 'invalid_limit', limit };

/** Distinct, non-blank, and not more than a person would ever select. */
const cleanValues = (values: readonly string[]): string[] =>
  [...new Set(values)].filter((value) => value.trim().length > 0);

type CleanedFilters = {
  readonly brands: string[];
  readonly options: { name: string; values: string[] }[];
};

const cleanFilters = (
  input: SearchProductsInput,
): { ok: true; value: CleanedFilters } | { ok: false; error: SearchProductsError } => {
  const brands = cleanValues(input.brands ?? []);
  if (brands.length > MAX_FILTER_VALUES) {
    return { ok: false, error: { tag: 'too_many_filter_values', field: 'brands' } };
  }

  const options: { name: string; values: string[] }[] = [];
  for (const option of input.options ?? []) {
    const values = cleanValues(option.values);
    // An option with nothing selected is not a filter; dropping it beats
    // sending the repository a clause that matches everything.
    if (values.length === 0) continue;
    if (values.length > MAX_FILTER_VALUES) {
      return { ok: false, error: { tag: 'too_many_filter_values', field: option.name } };
    }
    options.push({ name: option.name, values });
  }

  if (options.length > MAX_FILTER_VALUES) {
    return { ok: false, error: { tag: 'too_many_filter_values', field: 'options' } };
  }

  return { ok: true, value: { brands, options } };
};

const validatePriceRange = (
  minCents: number | undefined,
  maxCents: number | undefined,
): SearchProductsError | null => {
  if (minCents !== undefined && minCents < 0) {
    return { tag: 'invalid_price_range', minCents, maxCents: maxCents ?? 0 };
  }
  // Refused rather than swapped. A reversed range means the UI or the link is
  // wrong, and silently correcting it hides that from whoever built it.
  if (minCents !== undefined && maxCents !== undefined && minCents > maxCents) {
    return { tag: 'invalid_price_range', minCents, maxCents };
  }
  return null;
};

export const makeSearchProducts =
  (deps: { repository: ProductRepository; storeId: string }): SearchProducts =>
  async (input = {}) => {
    const limit = input.limit ?? DEFAULT_PAGE_SIZE;
    const limitProblem = validateLimit(limit);
    if (limitProblem !== null) return err(limitProblem);

    const cleaned = cleanFilters(input);
    if (!cleaned.ok) return err(cleaned.error);

    const priceMinCents = boundedInteger(input.priceMinCents);
    const priceMaxCents = boundedInteger(input.priceMaxCents);
    const priceProblem = validatePriceRange(priceMinCents, priceMaxCents);
    if (priceProblem !== null) return err(priceProblem);

    const { brands, options } = cleaned.value;

    const filters: ProductFilters = compact({
      // A query of whitespace is not a search; passing it through would cost a
      // text index lookup that can only return nothing.
      search: input.search !== undefined && isSearchable(input.search) ? input.search : undefined,
      brands: brands.length > 0 ? brands : undefined,
      options: options.length > 0 ? options : undefined,
      priceMinCents,
      priceMaxCents,
    });

    return ok(
      await deps.repository.search(
        compact({
          storeId: deps.storeId,
          limit,
          // Same single gate as listProducts: `status` cannot reach around it.
          status: input.includeUnpublished === true ? undefined : ('active' as const),
          cursor: input.cursor,
          filters,
        }),
      ),
    );
  };
