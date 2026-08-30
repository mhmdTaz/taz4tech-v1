import { englishOnly } from '@platform/locale';
import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { describe, expect, it } from 'vitest';
import type { Product, Variant } from '../domain/product';
import {
  buildBreadcrumbStructuredData,
  buildProductStructuredData,
  productPath,
  productUrl,
} from './product-structured-data';

const NOW = new Date('2026-08-27T10:00:00Z');
const LATER = new Date('2026-12-01T00:00:00Z');
const SITE = 'https://taz4tech.com';
const usd = (cents: number) => unwrapOrThrow(fromCents(cents));

const variant = (overrides: Partial<Variant> = {}): Variant => ({
  sku: 'SKU-1',
  options: [],
  price: usd(129900),
  compareAtPrice: null,
  offerEndsAt: null,
  barcode: null,
  weightGrams: null,
  ...overrides,
});

const product = (overrides: Partial<Product> = {}): Product => ({
  storeId: 'taz4tech',
  id: 'PRODUCT0000000000000000AA',
  slug: 'lenovo-ideapad-3',
  title: { en: 'Lenovo IdeaPad 3', ar: 'لينوفو ايديا باد 3' },
  description: { en: 'A laptop.', ar: 'حاسوب محمول.' },
  brand: 'Lenovo',
  status: 'active',
  optionNames: [],
  variants: [variant()],
  media: [],
  specs: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const build = (p: Product, locale: 'en' | 'ar' | 'fr' = 'en') =>
  buildProductStructuredData(p, { siteUrl: SITE, locale, availability: 'InStock' }, NOW);

describe('product URLs', () => {
  it('builds a locale-prefixed path', () => {
    expect(productPath('ar', 'lenovo-ideapad-3')).toBe('/ar/products/lenovo-ideapad-3');
  });

  it('builds an absolute URL', () => {
    expect(productUrl(SITE, 'en', 'lenovo-ideapad-3')).toBe(
      'https://taz4tech.com/en/products/lenovo-ideapad-3',
    );
  });
});

describe('buildProductStructuredData', () => {
  it('emits a valid Product node', () => {
    const data = build(product());
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('Product');
    expect(data.name).toBe('Lenovo IdeaPad 3');
    expect(data.sku).toBe('SKU-1');
    expect(data.url).toBe('https://taz4tech.com/en/products/lenovo-ideapad-3');
  });

  it('uses the requested locale for name and description', () => {
    const data = build(product(), 'ar');
    expect(data.name).toBe('لينوفو ايديا باد 3');
    expect(data.description).toBe('حاسوب محمول.');
    expect(data.url).toContain('/ar/');
  });

  it('falls back to English for an untranslated locale', () => {
    const data = build(product(), 'fr');
    expect(data.name).toBe('Lenovo IdeaPad 3');
  });

  it('includes the brand when there is one, and omits the key when not', () => {
    expect(build(product()).brand).toEqual({ '@type': 'Brand', name: 'Lenovo' });
    expect(Object.hasOwn(build(product({ brand: null })), 'brand')).toBe(false);
  });

  it('emits absolute image URLs and skips video', () => {
    const data = build(
      product({
        media: [
          { kind: 'image', url: '/media/a.webp', alt: englishOnly('Front'), width: 8, height: 6 },
          {
            kind: 'video',
            url: '/media/a.mp4',
            alt: englishOnly('Demo'),
            width: null,
            height: null,
          },
        ],
      }),
    );
    expect(data.image).toEqual(['https://taz4tech.com/media/a.webp']);
  });

  it('leaves an already-absolute image URL alone', () => {
    const data = build(
      product({
        media: [
          {
            kind: 'image',
            url: 'https://cdn.example/a.webp',
            alt: englishOnly('F'),
            width: null,
            height: null,
          },
        ],
      }),
    );
    expect(data.image).toEqual(['https://cdn.example/a.webp']);
  });

  it('absolutises an image path that has no leading slash', () => {
    // A spreadsheet import will happily produce "media/a.webp". Emitting that
    // verbatim gives Merchant Center a relative URL it cannot fetch.
    const data = build(
      product({
        media: [
          {
            kind: 'image',
            url: 'media/a.webp',
            alt: englishOnly('Front'),
            width: null,
            height: null,
          },
        ],
      }),
    );
    expect(data.image).toEqual(['https://taz4tech.com/media/a.webp']);
  });

  it('omits the image key entirely when there is no imagery', () => {
    expect(Object.hasOwn(build(product()), 'image')).toBe(false);
  });

  describe('offers', () => {
    it('emits a single Offer for a one-variant product', () => {
      const offers = build(product()).offers as Record<string, unknown>;
      expect(offers['@type']).toBe('Offer');
      expect(offers.price).toBe('1299.00');
      expect(offers.priceCurrency).toBe('USD');
      expect(offers.availability).toBe('https://schema.org/InStock');
    });

    it('emits an AggregateOffer spanning the real range for a multi-variant product', () => {
      // A single Offer here would advertise a price most buyers cannot get,
      // which is the mismatch Merchant Center suspends accounts over.
      const offers = build(
        product({
          optionNames: ['Storage'],
          variants: [
            variant({
              sku: 'A',
              options: [{ name: 'Storage', value: '256GB' }],
              price: usd(119900),
            }),
            variant({
              sku: 'B',
              options: [{ name: 'Storage', value: '512GB' }],
              price: usd(149900),
            }),
          ],
        }),
      ).offers as Record<string, unknown>;

      expect(offers['@type']).toBe('AggregateOffer');
      expect(offers.lowPrice).toBe('1199.00');
      expect(offers.highPrice).toBe('1499.00');
      expect(offers.offerCount).toBe(2);
    });

    it('publishes priceValidUntil while an offer is live', () => {
      const offers = build(
        product({
          variants: [
            variant({ price: usd(99900), compareAtPrice: usd(129900), offerEndsAt: LATER }),
          ],
        }),
      ).offers as Record<string, unknown>;
      // The legally required expiry is the same field Google uses to stop
      // showing a sale price.
      expect(offers.priceValidUntil).toBe('2026-12-01');
    });

    it('omits priceValidUntil once the offer has expired', () => {
      const expired = buildProductStructuredData(
        product({
          variants: [
            variant({ price: usd(99900), compareAtPrice: usd(129900), offerEndsAt: LATER }),
          ],
        }),
        { siteUrl: SITE, locale: 'en', availability: 'InStock' },
        new Date(LATER.getTime() + 1),
      );
      expect(Object.hasOwn(expired.offers as object, 'priceValidUntil')).toBe(false);
    });

    it('reports the availability it was given rather than assuming', () => {
      const data = buildProductStructuredData(
        product(),
        { siteUrl: SITE, locale: 'en', availability: 'OutOfStock' },
        NOW,
      );
      expect((data.offers as Record<string, unknown>).availability).toBe(
        'https://schema.org/OutOfStock',
      );
    });

    it('quotes the cheapest variant as the headline SKU and price', () => {
      const data = build(
        product({
          optionNames: ['Storage'],
          variants: [
            variant({
              sku: 'BIG',
              options: [{ name: 'Storage', value: '512GB' }],
              price: usd(149900),
            }),
            variant({
              sku: 'SMALL',
              options: [{ name: 'Storage', value: '256GB' }],
              price: usd(119900),
            }),
          ],
        }),
      );
      expect(data.sku).toBe('SMALL');
    });
  });

  it('emits the spec table as additionalProperty', () => {
    const data = build(
      product({
        specs: [
          { name: englishOnly('RAM'), value: englishOnly('8 GB'), group: 'Memory' },
          { name: englishOnly('Weight'), value: englishOnly('1.6 kg'), group: null },
        ],
      }),
    );
    expect(data.additionalProperty).toEqual([
      { '@type': 'PropertyValue', name: 'RAM', value: '8 GB' },
      { '@type': 'PropertyValue', name: 'Weight', value: '1.6 kg' },
    ]);
  });

  it('omits additionalProperty when there are no specs', () => {
    expect(Object.hasOwn(build(product()), 'additionalProperty')).toBe(false);
  });

  it('serialises to JSON without throwing or leaking undefined', () => {
    const json = JSON.stringify(build(product()));
    expect(json).not.toContain('undefined');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe('the breadcrumb trail', () => {
  const crumbs = [
    { name: 'Taz4Tech', path: '/en' },
    { name: 'Products', path: '/en/products' },
    { name: 'Lenovo IdeaPad 3', path: '/en/products/lenovo-ideapad-3' },
  ];

  it('is a BreadcrumbList a crawler recognises', () => {
    const data = buildBreadcrumbStructuredData(crumbs, 'https://taz4tech.com');

    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('BreadcrumbList');

    // And every ENTRY is a ListItem. A BreadcrumbList whose entries are not
    // typed is dropped whole, and it looks correct in the page source while it
    // is being dropped — the same silent failure as a relative `item` below.
    const items = data.itemListElement as { '@type': string }[];
    expect(items.map((item) => item['@type'])).toEqual(['ListItem', 'ListItem', 'ListItem']);
  });

  it('numbers the positions from ONE, not zero', () => {
    // A list starting at 0 is silently ignored rather than reported.
    const data = buildBreadcrumbStructuredData(crumbs, 'https://taz4tech.com');
    const items = data.itemListElement as { position: number }[];

    expect(items.map((item) => item.position)).toEqual([1, 2, 3]);
  });

  it('gives every crumb an ABSOLUTE url', () => {
    // Google ignores a relative `item` exactly as it ignores a relative
    // canonical — silently, while the markup looks perfectly correct.
    const data = buildBreadcrumbStructuredData(crumbs, 'https://taz4tech.com');
    const items = data.itemListElement as { item: string }[];

    for (const item of items) expect(item.item).toMatch(/^https:\/\/taz4tech\.com\//);
  });

  it('keeps the order it was given', () => {
    const data = buildBreadcrumbStructuredData(crumbs, 'https://taz4tech.com');
    const items = data.itemListElement as { name: string }[];

    expect(items.map((item) => item.name)).toEqual(['Taz4Tech', 'Products', 'Lenovo IdeaPad 3']);
  });

  it('handles a trail of one without inventing anything', () => {
    const data = buildBreadcrumbStructuredData(
      [{ name: 'Taz4Tech', path: '/en' }],
      'https://x.test',
    );
    expect((data.itemListElement as unknown[]).length).toBe(1);
  });
});
