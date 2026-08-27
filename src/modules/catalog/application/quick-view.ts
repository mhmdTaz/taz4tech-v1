/**
 * The product, flattened for a quick-view dialog.
 *
 * A peek from the listing: enough to answer "what does it cost, does it come in
 * my size, is it on offer" without leaving the grid. Everything a full product
 * page adds beyond that — specs, JSON-LD, the breadcrumb, the gallery at full
 * size — is deliberately absent, because the full page is one click away and
 * duplicating it here would be maintaining two product pages.
 *
 * WHY THIS IS A VIEW MODEL AND NOT A PRODUCT
 * ------------------------------------------
 * It crosses a wire. A Product holds Money and Date objects and the domain's
 * error union; serialising it would make the wire format an accident of what
 * happened to be serialisable, and a shape change would silently change what
 * the browser receives. Same reasoning as the importer and bulk-edit reports.
 *
 * Text is resolved to ONE locale here rather than shipped in all three. The
 * dialog shows one language, and sending the other two triples the payload on
 * the connection this feature exists to be gentle with.
 */

import { type Locale, textFor } from '@platform/locale';
import type { Currency } from '@platform/money';
import { defaultVariant, isOnOffer, type Product, type Variant } from '../domain/product';
import { productPath } from './product-structured-data';

export type QuickViewOption = {
  readonly name: string;
  readonly value: string;
};

/**
 * Stock, as the catalogue is willing to talk about it.
 *
 * The catalogue does not know what stock is — it is a separate module with a
 * separate document, for reasons written down there. The caller supplies this,
 * exactly as it supplies availability to the JSON-LD builder, so the decision
 * stays visible at the composition point instead of being invented here.
 */
export type SkuAvailability = 'in_stock' | 'out_of_stock';

export type QuickViewVariant = {
  readonly sku: string;
  readonly options: readonly QuickViewOption[];
  readonly priceCents: number;
  /** Null unless this variant is on offer RIGHT NOW — expiry is applied here. */
  readonly compareAtCents: number | null;
  /** ISO 8601, or null. Rendered because the law requires the expiry to be shown. */
  readonly offerEndsAt: string | null;
  readonly availability: SkuAvailability;
};

export type QuickView = {
  readonly slug: string;
  readonly title: string;
  readonly brand: string | null;
  readonly description: string;
  /** Locale-prefixed path to the full product page. */
  readonly href: string;
  readonly images: readonly { readonly url: string; readonly alt: string }[];
  readonly optionNames: readonly string[];
  readonly variants: readonly QuickViewVariant[];
  /**
   * The variant shown first: the cheapest one that can actually be bought.
   *
   * Opening on a sold-out variant quotes a price the customer cannot have, and
   * makes the dialog's first impression a disabled button. The cheapest overall
   * is the fallback when nothing is in stock, so the price shown still matches
   * the tile they clicked.
   */
  readonly defaultSku: string;
  readonly currency: Currency;
};

export type QuickViewOptions = {
  readonly locale: Locale;
  readonly now: Date;
  /**
   * SKU -> availability. A SKU that is absent reads as IN STOCK, matching the
   * inventory module's rule that an uncounted SKU is not one that ran out.
   */
  readonly availability?: ReadonlyMap<string, SkuAvailability>;
};

/**
 * The offer on this variant, if there is one running right now.
 *
 * Expiry is applied HERE, against a server clock, not in the browser. Leaving it
 * to the client would let a device with a wrong date show a discount that ended
 * last month — or hide one that is live — and the customer would be quoted a
 * price the business did not intend, at the door, in cash.
 */
const liveOffer = (
  variant: Variant,
  now: Date,
): { readonly compareAtCents: number; readonly offerEndsAt: string } | null => {
  const { compareAtPrice, offerEndsAt } = variant;
  if (compareAtPrice === null || offerEndsAt === null) return null;
  if (!isOnOffer(variant, now)) return null;

  return { compareAtCents: compareAtPrice.cents, offerEndsAt: offerEndsAt.toISOString() };
};

/**
 * The cheapest variant that can actually be bought, or the cheapest overall.
 *
 * Falling back rather than showing nothing keeps the quoted price matching the
 * tile the customer just clicked, even when the whole product is sold out.
 */
const cheapestSellable = (
  product: Product,
  availabilityOf: (sku: string) => SkuAvailability,
  fallback: Variant,
): Variant => {
  const sellable = product.variants.filter((variant) => availabilityOf(variant.sku) === 'in_stock');
  if (sellable.length === 0) return fallback;

  return sellable.reduce((cheapest, variant) =>
    variant.price.cents < cheapest.price.cents ? variant : cheapest,
  );
};

export const toQuickView = (product: Product, options: QuickViewOptions): QuickView => {
  const { locale, now } = options;
  const cheapest = defaultVariant(product);
  const availabilityOf = (sku: string): SkuAvailability =>
    options.availability?.get(sku) ?? 'in_stock';

  return {
    slug: product.slug,
    title: textFor(product.title, locale),
    brand: product.brand,
    description: textFor(product.description, locale),
    href: productPath(locale, product.slug),
    images: product.media
      .filter((item) => item.kind === 'image')
      .map((image) => ({ url: image.url, alt: textFor(image.alt, locale) })),
    optionNames: product.optionNames,
    variants: product.variants.map((variant) => {
      const offer = liveOffer(variant, now);
      return {
        sku: variant.sku,
        options: variant.options.map((option) => ({ name: option.name, value: option.value })),
        priceCents: variant.price.cents,
        compareAtCents: offer === null ? null : offer.compareAtCents,
        offerEndsAt: offer === null ? null : offer.offerEndsAt,
        availability: availabilityOf(variant.sku),
      };
    }),
    defaultSku: cheapestSellable(product, availabilityOf, cheapest).sku,
    currency: cheapest.price.currency,
  };
};
