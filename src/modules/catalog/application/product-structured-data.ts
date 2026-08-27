/**
 * schema.org Product JSON-LD.
 *
 * Lives here, not in the page component, because it is pure and consequential:
 * Merchant Center free listings are one of the few channels that actually reach
 * buyers for this vertical (and feed Gemini), and a malformed offer block is
 * rejected silently. A Server Component cannot be unit tested; this can, and is.
 *
 * Deliberately NOT a full feed. This is the on-page markup; the Merchant Center
 * and Meta feeds in Phase 4 are separate generators with their own required
 * fields.
 */

import type { Locale } from '@platform/locale';
import { textFor } from '@platform/locale';
import { toDecimalString } from '@platform/money';
import { defaultVariant, isOnOffer, type Product, priceRange } from '../domain/product';

/**
 * Stock is not tracked until Phase 2, so availability is supplied by the caller
 * rather than guessed here. Claiming InStock for something that is not is a
 * Merchant Center violation, and inventing the claim inside this function would
 * hide that decision from whoever wires stock up later.
 */
export type Availability = 'InStock' | 'OutOfStock' | 'PreOrder';

export type StructuredDataOptions = {
  /** Canonical origin, no trailing slash. */
  readonly siteUrl: string;
  readonly locale: Locale;
  readonly availability: Availability;
};

export type ProductStructuredData = Record<string, unknown>;

const absoluteUrl = (siteUrl: string, path: string): string =>
  path.startsWith('http') ? path : `${siteUrl}${path.startsWith('/') ? path : `/${path}`}`;

export const productPath = (locale: Locale, slug: string): string => `/${locale}/products/${slug}`;

export const productUrl = (siteUrl: string, locale: Locale, slug: string): string =>
  `${siteUrl}${productPath(locale, slug)}`;

export const buildProductStructuredData = (
  product: Product,
  options: StructuredDataOptions,
  now: Date,
): ProductStructuredData => {
  const { siteUrl, locale, availability } = options;
  const url = productUrl(siteUrl, locale, product.slug);
  const { from, to } = priceRange(product);
  const cheapest = defaultVariant(product);
  const schemaAvailability = `https://schema.org/${availability}`;

  /*
   * isOnOffer already guarantees offerEndsAt is set, so writing
   * `isOnOffer(...) && offerEndsAt !== null` would add a branch that can never
   * be false — untestable, and it would sit inside a 100%-coverage layer.
   * Narrowing to a value instead keeps both arms reachable.
   */
  const liveOfferEndsAt = isOnOffer(cheapest, now) ? cheapest.offerEndsAt : null;

  const images = product.media
    .filter((item) => item.kind === 'image')
    .map((item) => absoluteUrl(siteUrl, item.url));

  /*
   * A single-variant product gets an Offer; a multi-variant one gets an
   * AggregateOffer with the real low/high. Emitting a single Offer for a product
   * whose variants span $1,199-$1,499 advertises a price most buyers cannot get,
   * which is the exact mismatch Merchant Center suspends accounts for.
   */
  const offers =
    product.variants.length === 1
      ? {
          '@type': 'Offer',
          url,
          priceCurrency: cheapest.price.currency,
          price: toDecimalString(cheapest.price),
          availability: schemaAvailability,
          // The legally required offer expiry doubles as the field Google uses
          // to decide when to stop showing a sale price.
          ...(liveOfferEndsAt === null
            ? {}
            : { priceValidUntil: liveOfferEndsAt.toISOString().slice(0, 10) }),
        }
      : {
          '@type': 'AggregateOffer',
          url,
          priceCurrency: from.currency,
          lowPrice: toDecimalString(from),
          highPrice: toDecimalString(to),
          offerCount: product.variants.length,
          availability: schemaAvailability,
        };

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: textFor(product.title, locale),
    description: textFor(product.description, locale),
    sku: cheapest.sku,
    url,
    ...(images.length > 0 ? { image: images } : {}),
    ...(product.brand === null ? {} : { brand: { '@type': 'Brand', name: product.brand } }),
    offers,
    ...(product.specs.length > 0
      ? {
          // First-party spec tables are what long-tail compatibility queries
          // land on, so they are emitted as structured data too, not only as
          // a rendered table.
          additionalProperty: product.specs.map((spec) => ({
            '@type': 'PropertyValue',
            name: textFor(spec.name, locale),
            value: textFor(spec.value, locale),
          })),
        }
      : {}),
  };
};
