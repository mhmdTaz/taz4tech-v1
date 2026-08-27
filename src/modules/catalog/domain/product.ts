/**
 * Products and their variants.
 *
 * Framework-free and IO-free. This is the file mutation testing runs against, so
 * every branch has to earn its place.
 *
 * SHAPE
 * -----
 * A product embeds its variants; stock lives in its own collection. That split
 * is by write frequency, not by taste: product data changes rarely and is read
 * on every page view, so embedding keeps a product page to a single query. Stock
 * changes on every order and would otherwise rewrite the whole product document
 * under contention.
 *
 * A product with no options is still a product with one variant — the "default"
 * variant carrying the SKU and price. Modelling simple products as a special
 * case without variants would double every downstream branch (cart, invoice,
 * stock, returns) for the rest of the system's life.
 */

import type { EntityId } from '@platform/ids';
import type { LocalizedText } from '@platform/locale';
import { createLocalizedText, type LocalizedTextError } from '@platform/locale';
import { compare, isNegative, type Money } from '@platform/money';
import { err, ok, type Result } from '@platform/result';

export type ProductId = EntityId<'Product'>;

export type ProductStatus = 'draft' | 'active' | 'archived';

export const PRODUCT_STATUSES = [
  'draft',
  'active',
  'archived',
] as const satisfies readonly ProductStatus[];

/** One axis of a variant, e.g. { name: 'Colour', value: 'Black' }. Order is display order. */
export type VariantOption = {
  readonly name: string;
  readonly value: string;
};

export type Variant = {
  readonly sku: string;
  /** Empty for a product with no options. Otherwise matches the product's optionNames, in order. */
  readonly options: readonly VariantOption[];
  readonly price: Money;
  /**
   * The "was" price. Never set without offerEndsAt — see the invariant below.
   */
  readonly compareAtPrice: Money | null;
  /**
   * When the special offer ends.
   *
   * Lebanese consumer protection law requires every special offer to carry an
   * expiry date, so the type makes "discount with no end date" unrepresentable
   * rather than leaving it to a validation somebody remembers to run.
   */
  readonly offerEndsAt: Date | null;
  readonly barcode: string | null;
  readonly weightGrams: number | null;
};

export type Media = {
  readonly kind: 'image' | 'video';
  readonly url: string;
  /**
   * Required, and localized. An image without alt text is a WCAG failure that
   * axe will catch in CI, so it is cheaper to make it impossible here.
   */
  readonly alt: LocalizedText;
  readonly width: number | null;
  readonly height: number | null;
};

/**
 * A row in the spec table.
 *
 * First-party spec tables are one of the few things that measurably work for
 * this vertical — long-tail compatibility queries land on them — so they are a
 * first-class part of the model rather than free text in the description.
 */
export type Spec = {
  readonly name: LocalizedText;
  readonly value: LocalizedText;
  /** e.g. "Display", "Battery". Null groups render before the grouped ones. */
  readonly group: string | null;
};

export type Product = {
  readonly storeId: string;
  readonly id: ProductId;
  readonly slug: string;
  readonly title: LocalizedText;
  readonly description: LocalizedText;
  readonly brand: string | null;
  readonly status: ProductStatus;
  /** The variant axes, in display order. Empty for a product with a single default variant. */
  readonly optionNames: readonly string[];
  readonly variants: readonly Variant[];
  readonly media: readonly Media[];
  readonly specs: readonly Spec[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type ProductError =
  | { readonly tag: 'slug_invalid'; readonly slug: string }
  | { readonly tag: 'title_invalid'; readonly reason: LocalizedTextError }
  | { readonly tag: 'description_invalid'; readonly reason: LocalizedTextError }
  | { readonly tag: 'no_variants' }
  | { readonly tag: 'sku_empty'; readonly index: number }
  | { readonly tag: 'sku_duplicated'; readonly sku: string }
  | { readonly tag: 'option_names_duplicated'; readonly name: string }
  | { readonly tag: 'option_name_empty' }
  | {
      readonly tag: 'variant_options_mismatch';
      readonly sku: string;
      readonly expected: readonly string[];
    }
  | { readonly tag: 'variant_option_value_empty'; readonly sku: string; readonly name: string }
  | { readonly tag: 'variant_combination_duplicated'; readonly combination: string }
  | { readonly tag: 'price_negative'; readonly sku: string }
  | { readonly tag: 'compare_at_not_higher'; readonly sku: string }
  | { readonly tag: 'offer_without_end_date'; readonly sku: string }
  | { readonly tag: 'offer_end_date_in_past'; readonly sku: string }
  | { readonly tag: 'offer_end_date_without_offer'; readonly sku: string }
  | { readonly tag: 'media_url_empty'; readonly index: number }
  | {
      readonly tag: 'media_alt_invalid';
      readonly index: number;
      readonly reason: LocalizedTextError;
    }
  | { readonly tag: 'spec_invalid'; readonly index: number; readonly reason: LocalizedTextError };

/** Lowercase, hyphen-separated, no leading/trailing/double hyphens. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 120;

export const isValidSlug = (slug: string): boolean =>
  slug.length > 0 && slug.length <= SLUG_MAX && SLUG.test(slug);

/**
 * Build a URL slug from a title.
 *
 * Latin-only by design: the canonical product URL is the same in every locale,
 * so /en/p/lenovo-ideapad-3 and /ar/p/lenovo-ideapad-3 differ only by the locale
 * segment. That keeps one canonical URL per locale for hreflang, and keeps links
 * shareable between an Arabic customer and an English one. Arabic and French
 * titles still render translated; only the path stays stable.
 */
export const slugify = (input: string): string =>
  input
    .normalize('NFKD')
    // NFKD splits an accented letter into letter + combining mark; \p{M} then
    // drops the marks. Using the property escape keeps the source ASCII, so the
    // rule cannot be broken by an encoding change nobody can see in a diff.
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');

const optionKey = (options: readonly VariantOption[]): string =>
  options.map((o) => `${o.name}=${o.value}`).join('|');

const validateVariant = (
  variant: Variant,
  index: number,
  optionNames: readonly string[],
  now: Date,
): ProductError | null => {
  if (variant.sku.trim().length === 0) return { tag: 'sku_empty', index };

  if (variant.options.length !== optionNames.length) {
    return { tag: 'variant_options_mismatch', sku: variant.sku, expected: optionNames };
  }
  for (const [i, option] of variant.options.entries()) {
    if (option.name !== optionNames[i]) {
      return { tag: 'variant_options_mismatch', sku: variant.sku, expected: optionNames };
    }
    if (option.value.trim().length === 0) {
      return { tag: 'variant_option_value_empty', sku: variant.sku, name: option.name };
    }
  }

  if (isNegative(variant.price)) return { tag: 'price_negative', sku: variant.sku };

  if (variant.compareAtPrice !== null) {
    // A "was" price at or below the current price is not a discount; showing one
    // is a misleading commercial claim, not a display bug.
    if (compare(variant.compareAtPrice, variant.price) <= 0) {
      return { tag: 'compare_at_not_higher', sku: variant.sku };
    }
    if (variant.offerEndsAt === null) return { tag: 'offer_without_end_date', sku: variant.sku };
    if (variant.offerEndsAt.getTime() <= now.getTime()) {
      return { tag: 'offer_end_date_in_past', sku: variant.sku };
    }
  } else if (variant.offerEndsAt !== null) {
    // An end date with nothing to end is a half-removed offer; rejecting it
    // stops "the discount is gone but the banner is still up".
    return { tag: 'offer_end_date_without_offer', sku: variant.sku };
  }

  return null;
};

/**
 * The only way to obtain a Product. Every invariant is checked here, so a value
 * of this type is trustworthy everywhere else without re-validation.
 *
 * `now` is a parameter rather than a call to Date.now() so that offer expiry is
 * testable without waiting and without a global clock inside the domain.
 */
export const createProduct = (input: Product, now: Date): Result<Product, ProductError> => {
  if (!isValidSlug(input.slug)) return err({ tag: 'slug_invalid', slug: input.slug });

  const title = createLocalizedText(input.title);
  if (!title.ok) return err({ tag: 'title_invalid', reason: title.error });

  const description = createLocalizedText(input.description);
  if (!description.ok) return err({ tag: 'description_invalid', reason: description.error });

  const seenOptionNames = new Set<string>();
  for (const name of input.optionNames) {
    if (name.trim().length === 0) return err({ tag: 'option_name_empty' });
    if (seenOptionNames.has(name)) return err({ tag: 'option_names_duplicated', name });
    seenOptionNames.add(name);
  }

  if (input.variants.length === 0) return err({ tag: 'no_variants' });

  const seenSkus = new Set<string>();
  const seenCombinations = new Set<string>();
  for (const [index, variant] of input.variants.entries()) {
    const problem = validateVariant(variant, index, input.optionNames, now);
    if (problem !== null) return err(problem);

    if (seenSkus.has(variant.sku)) return err({ tag: 'sku_duplicated', sku: variant.sku });
    seenSkus.add(variant.sku);

    const combination = optionKey(variant.options);
    if (seenCombinations.has(combination)) {
      return err({ tag: 'variant_combination_duplicated', combination });
    }
    seenCombinations.add(combination);
  }

  for (const [index, item] of input.media.entries()) {
    if (item.url.trim().length === 0) return err({ tag: 'media_url_empty', index });
    const alt = createLocalizedText(item.alt);
    if (!alt.ok) return err({ tag: 'media_alt_invalid', index, reason: alt.error });
  }

  for (const [index, spec] of input.specs.entries()) {
    const name = createLocalizedText(spec.name);
    if (!name.ok) return err({ tag: 'spec_invalid', index, reason: name.error });
    const value = createLocalizedText(spec.value);
    if (!value.ok) return err({ tag: 'spec_invalid', index, reason: value.error });
  }

  return ok({
    ...input,
    title: title.value,
    description: description.value,
    brand: input.brand === null || input.brand.trim().length === 0 ? null : input.brand.trim(),
  });
};

// ---------------------------------------------------------------- reading

/** The variant shown first: the cheapest, so a listing price is never a surprise. */
export const defaultVariant = (product: Product): Variant =>
  // reduce without an initial value is typed as returning Variant, not
  // Variant | undefined, so the "at least one variant" invariant is expressed
  // without a cast and without an unreachable branch that coverage would flag.
  product.variants.reduce((cheapest, variant) =>
    compare(variant.price, cheapest.price) < 0 ? variant : cheapest,
  );

export const priceRange = (product: Product): { readonly from: Money; readonly to: Money } => {
  const prices = product.variants.map((variant) => variant.price);
  return {
    from: prices.reduce((lowest, price) => (compare(price, lowest) < 0 ? price : lowest)),
    to: prices.reduce((highest, price) => (compare(price, highest) > 0 ? price : highest)),
  };
};

export const hasPriceRange = (product: Product): boolean => {
  const { from, to } = priceRange(product);
  return compare(from, to) !== 0;
};

/**
 * Whether a variant is on offer *right now*.
 *
 * Expiry is evaluated on read rather than cleared by a scheduled job. A job that
 * fails leaves a stale discount live on the storefront — the customer is quoted
 * a price the business did not intend, at the door, in cash. Computing it means
 * an expired offer simply stops being an offer, with nothing left to go wrong.
 */
export const isOnOffer = (variant: Variant, now: Date): boolean =>
  variant.compareAtPrice !== null &&
  variant.offerEndsAt !== null &&
  variant.offerEndsAt.getTime() > now.getTime();

/** Visible to customers. Draft and archived products are not. */
export const isPurchasable = (product: Product): boolean => product.status === 'active';

/** Distinct values for one option axis, in first-seen order — drives the PDP swatches. */
export const optionValues = (product: Product, optionName: string): string[] => {
  const values: string[] = [];
  for (const variant of product.variants) {
    for (const option of variant.options) {
      if (option.name === optionName && !values.includes(option.value)) values.push(option.value);
    }
  }
  return values;
};

/** Find the variant matching an exact option selection, or null if there is none. */
export const findVariant = (
  product: Product,
  selection: readonly VariantOption[],
): Variant | null => {
  const wanted = optionKey(selection);
  return product.variants.find((variant) => optionKey(variant.options) === wanted) ?? null;
};
