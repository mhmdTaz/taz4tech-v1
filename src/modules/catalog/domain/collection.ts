/**
 * Collections — the shop's own groupings of products.
 *
 * "Laptops", "Gaming", "Under $100", "Back to school". They are what navigation
 * is built from and what the Phase 3 homepage sections will point at.
 *
 * SHAPE: A SAVED QUERY, PLUS PINNED PRODUCTS
 * ------------------------------------------
 * A collection does not hold a copy of its products. It holds the same
 * ProductFilters the listing page already uses, plus an explicit list of pinned
 * ids. That choice buys three things:
 *
 * 1. A collection page inherits search, facets and pagination unchanged, rather
 *    than growing a second listing path that drifts from the first.
 * 2. A rule-based collection stays correct on its own: import fifty new Lenovo
 *    laptops and "Laptops" contains them, with nobody editing anything.
 * 3. Curation still works, because pinned ids are a union with the rules — the
 *    one accessory that belongs in "Gaming" without matching any rule.
 *
 * Membership is `(matches the rules) OR (is pinned)`. Whatever the CUSTOMER
 * then filters is ANDed on top, so a pinned product cannot survive a filter it
 * does not match — a pinned Dell must disappear when someone asks for Lenovo.
 */

import type { EntityId } from '@platform/ids';
import type { LocalizedText } from '@platform/locale';
import { createLocalizedText, type LocalizedTextError } from '@platform/locale';
import { err, ok, type Result } from '@platform/result';
import { isValidSlug, type ProductId } from './product';

export type CollectionId = EntityId<'Collection'>;

/** Same three states as a product, for the same reason: publishing is a decision. */
export type CollectionStatus = 'draft' | 'active' | 'archived';

export const COLLECTION_STATUSES = [
  'draft',
  'active',
  'archived',
] as const satisfies readonly CollectionStatus[];

/**
 * How a collection orders its products.
 *
 * 'manual' honours the pinned order first, then falls back to newest — a
 * curated collection is usually curated only at the top.
 */
export const COLLECTION_SORTS = ['newest', 'price-asc', 'price-desc', 'manual'] as const;
export type CollectionSort = (typeof COLLECTION_SORTS)[number];

/**
 * The rules half of membership.
 *
 * Deliberately the same vocabulary as the customer-facing filters, so there is
 * one definition of "Lenovo laptops under $500" in the system rather than two
 * that can disagree.
 */
export type CollectionRules = {
  readonly brands?: readonly string[];
  readonly options?: readonly { readonly name: string; readonly values: readonly string[] }[];
  readonly priceMinCents?: number;
  readonly priceMaxCents?: number;
};

export type Collection = {
  readonly storeId: string;
  readonly id: CollectionId;
  readonly slug: string;
  readonly title: LocalizedText;
  readonly description: LocalizedText;
  readonly status: CollectionStatus;
  readonly rules: CollectionRules;
  /** Always included, whatever the rules say. Order is the curated order. */
  readonly pinnedProductIds: readonly ProductId[];
  readonly sort: CollectionSort;
  /** Display order among sibling collections in navigation. */
  readonly position: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type CollectionError =
  | { readonly tag: 'slug_invalid'; readonly slug: string }
  | { readonly tag: 'title_invalid'; readonly reason: LocalizedTextError }
  | { readonly tag: 'description_invalid'; readonly reason: LocalizedTextError }
  | { readonly tag: 'no_membership' }
  | { readonly tag: 'brand_empty' }
  | { readonly tag: 'option_name_empty' }
  | { readonly tag: 'option_values_empty'; readonly name: string }
  | { readonly tag: 'price_negative' }
  | { readonly tag: 'price_range_reversed'; readonly minCents: number; readonly maxCents: number }
  | { readonly tag: 'pinned_duplicated'; readonly productId: ProductId }
  | { readonly tag: 'position_invalid'; readonly position: number };

/** True when the rules would select nothing at all on their own. */
export const hasRules = (rules: CollectionRules): boolean =>
  (rules.brands !== undefined && rules.brands.length > 0) ||
  (rules.options !== undefined && rules.options.length > 0) ||
  rules.priceMinCents !== undefined ||
  rules.priceMaxCents !== undefined;

const validateRules = (rules: CollectionRules): CollectionError | null => {
  for (const brand of rules.brands ?? []) {
    if (brand.trim().length === 0) return { tag: 'brand_empty' };
  }

  for (const option of rules.options ?? []) {
    if (option.name.trim().length === 0) return { tag: 'option_name_empty' };
    // An option with no values selects everything on that axis, which is the
    // same as no rule at all — but reads in the admin as a filter that is on.
    if (option.values.length === 0) return { tag: 'option_values_empty', name: option.name };
    for (const value of option.values) {
      if (value.trim().length === 0) return { tag: 'option_values_empty', name: option.name };
    }
  }

  const min = rules.priceMinCents;
  const max = rules.priceMaxCents;
  if ((min !== undefined && min < 0) || (max !== undefined && max < 0)) {
    return { tag: 'price_negative' };
  }
  if (min !== undefined && max !== undefined && min > max) {
    return { tag: 'price_range_reversed', minCents: min, maxCents: max };
  }

  return null;
};

/**
 * The only way to obtain a Collection.
 *
 * The invariant worth noting is `no_membership`: a collection with neither rules
 * nor pinned products can never contain anything. Allowing it means the shop
 * publishes navigation that leads to an empty page, which reads to a customer
 * as a broken site rather than an empty category.
 */
export const createCollection = (input: Collection): Result<Collection, CollectionError> => {
  if (!isValidSlug(input.slug)) return err({ tag: 'slug_invalid', slug: input.slug });

  const title = createLocalizedText(input.title);
  if (!title.ok) return err({ tag: 'title_invalid', reason: title.error });

  const description = createLocalizedText(input.description);
  if (!description.ok) return err({ tag: 'description_invalid', reason: description.error });

  const rulesProblem = validateRules(input.rules);
  if (rulesProblem !== null) return err(rulesProblem);

  if (!hasRules(input.rules) && input.pinnedProductIds.length === 0) {
    return err({ tag: 'no_membership' });
  }

  const seen = new Set<ProductId>();
  for (const productId of input.pinnedProductIds) {
    // A duplicate would render the product twice in a manual sort.
    if (seen.has(productId)) return err({ tag: 'pinned_duplicated', productId });
    seen.add(productId);
  }

  if (!Number.isInteger(input.position) || input.position < 0) {
    return err({ tag: 'position_invalid', position: input.position });
  }

  return ok({ ...input, title: title.value, description: description.value });
};

/** Visible to customers. Draft and archived collections are not. */
export const isPublished = (collection: Collection): boolean => collection.status === 'active';

/**
 * A collection whose membership is entirely curated.
 *
 * Worth distinguishing because it is the only case where 'manual' sort is fully
 * meaningful — a rule-based collection has products the curator never ordered.
 */
export const isFullyCurated = (collection: Collection): boolean => !hasRules(collection.rules);

/** Navigation order: position first, then title, so ties are stable rather than arbitrary. */
export const compareForNavigation = (a: Collection, b: Collection): number =>
  a.position - b.position || a.title.en.localeCompare(b.title.en);
