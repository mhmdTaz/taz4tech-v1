/**
 * Applying one bulk operation to one product.
 *
 * Pure, and deliberately per-product: the interesting decisions are all local
 * (does this change anything? does the result still hold together?), and keeping
 * them here means the awkward cases are tested as plain objects rather than
 * through a database and a form.
 *
 * THREE OUTCOMES, NOT TWO
 * -----------------------
 * changed / unchanged / refused. "Unchanged" earns its place: setting status to
 * active on a product that is already active must not be reported as a change
 * the operator is about to make, and must not be written — a pointless write
 * moves updatedAt, which is the field the storefront sorts and caches on.
 *
 * EVERY RESULT GOES BACK THROUGH createProduct
 * --------------------------------------------
 * A bulk edit is the easiest way to put the catalogue into a state nobody
 * intended: raise every price by 5% and a product whose was-price sat just above
 * the new price is now advertising a discount of zero. Revalidating means those
 * products are REFUSED with a reason, one at a time, instead of being written.
 */

import { scaleByBasisPoints } from '@platform/money';
import {
  createProduct,
  type Product,
  type ProductError,
  type ProductStatus,
  type Variant,
} from './product';

export type BulkOperation =
  | { readonly tag: 'set_status'; readonly status: ProductStatus }
  /** null clears the brand. */
  | { readonly tag: 'set_brand'; readonly brand: string | null }
  /** 10000 is unchanged; 10500 is +5%. See scaleByBasisPoints for why not a float. */
  | { readonly tag: 'scale_price'; readonly basisPoints: number }
  /** Drop compareAtPrice and offerEndsAt, which is how an expired offer is cleared. */
  | { readonly tag: 'clear_offer' };

export type BulkRefusal =
  /** The edited product no longer satisfies the domain. */
  | { readonly tag: 'invalid_result'; readonly reason: ProductError }
  /** The arithmetic left the range where cents are exact. */
  | { readonly tag: 'price_unrepresentable'; readonly sku: string };

export type BulkOutcome =
  | { readonly tag: 'changed'; readonly product: Product }
  | { readonly tag: 'unchanged' }
  | { readonly tag: 'refused'; readonly reason: BulkRefusal };

/** The largest sensible price move, so a mistyped multiplier cannot ship. */
export const MIN_BASIS_POINTS = 1;
export const MAX_BASIS_POINTS = 100_000;

export const isValidBasisPoints = (value: number): boolean =>
  Number.isInteger(value) && value >= MIN_BASIS_POINTS && value <= MAX_BASIS_POINTS;

/**
 * A brand is stored trimmed, and blank means "no brand".
 *
 * Without this a bulk edit could set every brand to " ", which reads as present
 * to any check that only tests for null and renders as an empty chip on the
 * storefront.
 */
const cleanBrand = (brand: string | null): string | null => {
  if (brand === null) return null;
  const trimmed = brand.trim();
  return trimmed.length === 0 ? null : trimmed;
};

type VariantEdit =
  | { readonly ok: true; readonly variants: readonly Variant[]; readonly changed: boolean }
  | { readonly ok: false; readonly refusal: BulkRefusal };

const scaleVariants = (product: Product, basisPoints: number): VariantEdit => {
  const variants: Variant[] = [];
  let changed = false;

  for (const variant of product.variants) {
    const price = scaleByBasisPoints(variant.price, basisPoints);
    if (!price.ok)
      return { ok: false, refusal: { tag: 'price_unrepresentable', sku: variant.sku } };

    /*
     * compareAtPrice is NOT scaled with it.
     *
     * A was-price is a claim about what this product used to cost. Moving it in
     * step with the new price would keep the advertised discount looking the
     * same while quietly rewriting history, on the field Lebanese consumer
     * protection rules care about. Leaving it means the discount shrinks
     * honestly — and where the new price would meet or pass it, createProduct
     * refuses the product and the operator is told which one.
     */
    if (price.value.cents !== variant.price.cents) changed = true;
    variants.push({ ...variant, price: price.value });
  }

  return { ok: true, variants, changed };
};

const clearOffers = (product: Product): { variants: Variant[]; changed: boolean } => {
  const variants = product.variants.map((variant) => ({
    ...variant,
    compareAtPrice: null,
    offerEndsAt: null,
  }));
  const changed = product.variants.some(
    (variant) => variant.compareAtPrice !== null || variant.offerEndsAt !== null,
  );
  return { variants, changed };
};

/** The candidate product an operation produces, before it is revalidated. */
const edit = (
  product: Product,
  operation: BulkOperation,
): { ok: true; candidate: Product; changed: boolean } | { ok: false; refusal: BulkRefusal } => {
  switch (operation.tag) {
    case 'set_status':
      return {
        ok: true,
        candidate: { ...product, status: operation.status },
        changed: product.status !== operation.status,
      };

    case 'set_brand': {
      const brand = cleanBrand(operation.brand);
      return { ok: true, candidate: { ...product, brand }, changed: product.brand !== brand };
    }

    case 'scale_price': {
      const scaled = scaleVariants(product, operation.basisPoints);
      if (!scaled.ok) return { ok: false, refusal: scaled.refusal };
      return {
        ok: true,
        candidate: { ...product, variants: scaled.variants },
        changed: scaled.changed,
      };
    }

    case 'clear_offer': {
      const cleared = clearOffers(product);
      return {
        ok: true,
        candidate: { ...product, variants: cleared.variants },
        changed: cleared.changed,
      };
    }
  }

  /*
   * No default arm, deliberately. The switch covers the union, so the compiler
   * already knows this line is unreachable — and adding a fifth operation makes
   * the declared return type unsatisfiable, which is a build error rather than
   * a fallback that silently does nothing. A default here would instead be an
   * unreachable branch sitting in a layer gated at 100% coverage.
   */
};

export const applyBulkOperation = (
  product: Product,
  operation: BulkOperation,
  now: Date,
): BulkOutcome => {
  const edited = edit(product, operation);
  if (!edited.ok) return { tag: 'refused', reason: edited.refusal };

  // Checked BEFORE revalidating, on purpose. A product already sitting in an
  // invalid state — an offer that expired last month, say — must not be
  // reported as refused by an operation that would not have touched it.
  if (!edited.changed) return { tag: 'unchanged' };

  const validated = createProduct({ ...edited.candidate, updatedAt: now }, now);
  if (!validated.ok) {
    return { tag: 'refused', reason: { tag: 'invalid_result', reason: validated.error } };
  }

  return { tag: 'changed', product: validated.value };
};
