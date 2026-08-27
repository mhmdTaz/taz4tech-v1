/**
 * Pricing a cart.
 *
 * EVERY AMOUNT COMES FROM THE CATALOGUE, NONE FROM THE COOKIE
 * ----------------------------------------------------------
 * The cart cookie is under the customer's control, so it holds SKUs and
 * quantities and nothing else. This is where those become money — read live,
 * every render, from the same product records the storefront prices from. A cart
 * that trusted its own cookie would be a cart the customer could set the price
 * in.
 *
 * That also means the answer can CHANGE between adding something and checking
 * out: a price rises, an offer expires, a product is archived, the last one
 * sells. Each of those is reported as its own kind of problem rather than
 * silently applied, because a total that quietly moved is the single most
 * expensive thing a shop can do to a customer's trust.
 *
 * NOTHING IS RESERVED HERE
 * ------------------------
 * Stock is read to tell the truth about availability; it is not held. Reserving
 * at add-to-cart would let anyone empty a shop by filling a cart, and a COD shop
 * with one operator has no basket-expiry process to release them again. Stock
 * moves once, atomically, when an order is placed.
 */

import type { Product, Variant } from '@modules/catalog';
import { defaultVariant, isOnOffer } from '@modules/catalog';
import type { StockLevel } from '@modules/inventory';
import { availabilityOf, countToShow } from '@modules/inventory';
import type { Locale } from '@platform/locale';
import { textFor } from '@platform/locale';
import type { Currency } from '@platform/money';
import { USD } from '@platform/money';
import type { Cart } from '../domain/cart';

/**
 * Tracked, and fewer remain than the cart asks for.
 *
 * A line whose product has gone entirely is not a problem on a line — it is in
 * `removed`, because there is nothing left to show a price against.
 */
export type LineProblem = { readonly tag: 'not_enough'; readonly available: number };

export type PricedLine = {
  readonly sku: string;
  readonly quantity: number;
  readonly title: string;
  readonly href: string;
  readonly slug: string;
  readonly imageUrl: string | null;
  readonly imageAlt: string;
  /** The option values that identify this variant, e.g. "Black · 256GB". */
  readonly options: readonly { readonly name: string; readonly value: string }[];
  readonly unitPriceCents: number;
  /** The was-price, only when the offer is live right now. */
  readonly compareAtCents: number | null;
  /** unitPrice * quantity, in integer cents. */
  readonly lineTotalCents: number;
  readonly problem: LineProblem | null;
};

export type PricedCart = {
  readonly lines: readonly PricedLine[];
  /**
   * Lines the cart held that no longer resolve to anything sellable.
   *
   * Reported rather than dropped in silence: a cart that quietly shrinks is a
   * customer wondering what they forgot.
   */
  readonly removed: readonly { readonly sku: string; readonly quantity: number }[];
  readonly totalItems: number;
  readonly subtotalCents: number;
  readonly currency: Currency;
  /** True when at least one line cannot be ordered as it stands. */
  readonly hasProblems: boolean;
};

export type PriceCartDeps = {
  /** SKU -> product. Only active products, only the SKUs asked for. */
  readonly products: (skus: readonly string[]) => Promise<ReadonlyMap<string, Product>>;
  readonly stock: (skus: readonly string[]) => Promise<ReadonlyMap<string, StockLevel>>;
  readonly now: () => Date;
};

export type PriceCart = (cart: Cart, locale: Locale) => Promise<PricedCart>;

const variantFor = (product: Product, sku: string): Variant =>
  product.variants.find((variant) => variant.sku === sku) ?? defaultVariant(product);

/**
 * The live was-price, or null.
 *
 * Written as one narrowing check rather than `isOnOffer(...) ? v.compareAtPrice?.cents : null`,
 * which reads as if compareAtPrice might be absent on an offer that isOnOffer
 * has already said is running — a branch that cannot be taken.
 */
const liveCompareAt = (variant: Variant, now: Date): number | null => {
  const { compareAtPrice } = variant;
  if (compareAtPrice === null) return null;
  return isOnOffer(variant, now) ? compareAtPrice.cents : null;
};

const problemFor = (level: StockLevel | null, quantity: number): LineProblem | null => {
  if (availabilityOf(level) === 'out_of_stock') return { tag: 'not_enough', available: 0 };

  const available = countToShow(level);
  // null is an uncounted SKU: nothing to compare against, so nothing to report.
  if (available === null || available >= quantity) return null;

  return { tag: 'not_enough', available };
};

export const makePriceCart =
  (deps: PriceCartDeps): PriceCart =>
  async (cart, locale) => {
    if (cart.lines.length === 0) {
      return {
        lines: [],
        removed: [],
        totalItems: 0,
        subtotalCents: 0,
        currency: USD,
        hasProblems: false,
      };
    }

    const skus = cart.lines.map((line) => line.sku);
    // Both lookups at once: they are independent, and a cart page that waits for
    // one and then the other is a page that waits twice.
    const [products, levels] = await Promise.all([deps.products(skus), deps.stock(skus)]);
    const now = deps.now();

    const lines: PricedLine[] = [];
    const removed: { sku: string; quantity: number }[] = [];
    let currency: Currency = USD;

    for (const line of cart.lines) {
      const product = products.get(line.sku);
      if (product === undefined) {
        removed.push({ sku: line.sku, quantity: line.quantity });
        continue;
      }

      const variant = variantFor(product, line.sku);
      const image = product.media.find((item) => item.kind === 'image');
      currency = variant.price.currency;

      lines.push({
        sku: line.sku,
        quantity: line.quantity,
        title: textFor(product.title, locale),
        slug: product.slug,
        href: `/${locale}/products/${product.slug}?variant=${encodeURIComponent(line.sku)}`,
        imageUrl: image?.url ?? null,
        imageAlt: image === undefined ? '' : textFor(image.alt, locale),
        options: variant.options.map((option) => ({ name: option.name, value: option.value })),
        unitPriceCents: variant.price.cents,
        // Expiry is applied against the SERVER clock, exactly as on the product
        // page: a device with a wrong date must not show a discount that ended.
        compareAtCents: liveCompareAt(variant, now),
        lineTotalCents: variant.price.cents * line.quantity,
        problem: problemFor(levels.get(line.sku) ?? null, line.quantity),
      });
    }

    return {
      lines,
      removed,
      totalItems: lines.reduce((total, line) => total + line.quantity, 0),
      // Integer cents throughout, so a subtotal is a sum and never a rounding.
      subtotalCents: lines.reduce((total, line) => total + line.lineTotalCents, 0),
      currency,
      hasProblems: lines.some((line) => line.problem !== null) || removed.length > 0,
    };
  };
