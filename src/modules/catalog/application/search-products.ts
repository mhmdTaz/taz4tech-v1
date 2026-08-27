/**
 * Use case: a filtered, faceted page of products.
 *
 * Everything here arrives from a query string a customer controls, so this is
 * the layer that bounds it. `?limit=100000`, forty brand filters and a negative
 * price are requests in the delivery layer; here they are bounded numbers or
 * refusals.
 */

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

export const makeSearchProducts =
  (deps: { repository: ProductRepository; storeId: string }): SearchProducts =>
  async (input = {}) => {
    const limit = input.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      return err({ tag: 'invalid_limit', limit });
    }

    const brands = [...new Set(input.brands ?? [])].filter((brand) => brand.trim().length > 0);
    if (brands.length > MAX_FILTER_VALUES) {
      return err({ tag: 'too_many_filter_values', field: 'brands' });
    }

    const options: { name: string; values: string[] }[] = [];
    for (const option of input.options ?? []) {
      const values = [...new Set(option.values)].filter((value) => value.trim().length > 0);
      if (values.length === 0) continue;
      if (values.length > MAX_FILTER_VALUES) {
        return err({ tag: 'too_many_filter_values', field: option.name });
      }
      options.push({ name: option.name, values });
    }
    if (options.length > MAX_FILTER_VALUES) {
      return err({ tag: 'too_many_filter_values', field: 'options' });
    }

    const priceMinCents = boundedInteger(input.priceMinCents);
    const priceMaxCents = boundedInteger(input.priceMaxCents);
    if (
      priceMinCents !== undefined &&
      priceMaxCents !== undefined &&
      priceMinCents > priceMaxCents
    ) {
      // Refused rather than swapped. A reversed range means the UI or the link
      // is wrong, and silently correcting it hides that from whoever built it.
      return err({ tag: 'invalid_price_range', minCents: priceMinCents, maxCents: priceMaxCents });
    }
    if (priceMinCents !== undefined && priceMinCents < 0) {
      return err({
        tag: 'invalid_price_range',
        minCents: priceMinCents,
        maxCents: priceMaxCents ?? 0,
      });
    }

    const filters: ProductFilters = {
      // A query of whitespace is not a search; passing it through would cost a
      // text index lookup and return nothing.
      ...(input.search !== undefined && isSearchable(input.search) ? { search: input.search } : {}),
      ...(brands.length > 0 ? { brands } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(priceMinCents === undefined ? {} : { priceMinCents }),
      ...(priceMaxCents === undefined ? {} : { priceMaxCents }),
    };

    return ok(
      await deps.repository.search({
        storeId: deps.storeId,
        limit,
        // Same single gate as listProducts: `status` cannot reach around it.
        ...(input.includeUnpublished === true ? {} : { status: 'active' as const }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        filters,
      }),
    );
  };
