import type { EntityId } from '@platform/ids';
import { englishOnly } from '@platform/locale';
import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { describe, expect, it } from 'vitest';
import type { Product, Variant } from '../domain/product';
import { toQuickView } from './quick-view';

const NOW = new Date('2026-08-27T10:00:00Z');
const LATER = new Date('2026-12-31T10:00:00Z');
const EARLIER = new Date('2026-01-01T10:00:00Z');

const usd = (cents: number) => unwrapOrThrow(fromCents(cents));

const variant = (overrides: Partial<Variant> = {}): Variant => ({
  sku: 'SKU-1',
  options: [],
  price: usd(1999),
  compareAtPrice: null,
  offerEndsAt: null,
  barcode: null,
  weightGrams: null,
  ...overrides,
});

const product = (overrides: Partial<Product> = {}): Product => ({
  storeId: 'taz4tech',
  id: 'PRODUCT0000000000000001AA' as EntityId<'Product'>,
  slug: 'anker-cable',
  title: { en: 'Anker Cable', ar: 'كابل انكر' },
  description: englishOnly('A braided cable.'),
  brand: 'Anker',
  status: 'active',
  optionNames: [],
  variants: [variant()],
  media: [],
  specs: [],
  createdAt: EARLIER,
  updatedAt: EARLIER,
  ...overrides,
});

const view = (
  overrides: Partial<Product> = {},
  locale: 'en' | 'ar' | 'fr' = 'en',
  availability?: ReadonlyMap<string, 'in_stock' | 'out_of_stock'>,
) =>
  toQuickView(product(overrides), { locale, now: NOW, ...(availability ? { availability } : {}) });

describe('toQuickView', () => {
  it('carries the identity a dialog needs', () => {
    const result = view();
    expect(result.slug).toBe('anker-cable');
    expect(result.title).toBe('Anker Cable');
    expect(result.brand).toBe('Anker');
    expect(result.description).toBe('A braided cable.');
  });

  it('links to the full product page in the same locale', () => {
    // The dialog is a peek; the page is the thing that can be shared, indexed
    // and bookmarked, so the link has to be right.
    expect(view({}, 'ar').href).toBe('/ar/products/anker-cable');
  });

  it('resolves text to ONE locale rather than shipping all three', () => {
    expect(view({}, 'ar').title).toBe('كابل انكر');
  });

  it('falls back to English where a translation is missing', () => {
    expect(view({}, 'fr').title).toBe('Anker Cable');
  });

  it('keeps a null brand null rather than inventing an empty string', () => {
    expect(view({ brand: null }).brand).toBeNull();
  });

  describe('images', () => {
    it('carries url and translated alt text', () => {
      const result = view({
        media: [
          {
            kind: 'image',
            url: 'https://cdn.example/a.jpg',
            alt: { en: 'A cable', ar: 'كابل' },
            width: null,
            height: null,
          },
        ],
      });

      expect(result.images).toEqual([{ url: 'https://cdn.example/a.jpg', alt: 'A cable' }]);
    });

    it('translates alt text too — an Arabic dialog with English alt is half done', () => {
      const result = view(
        {
          media: [
            {
              kind: 'image',
              url: 'https://cdn.example/a.jpg',
              alt: { en: 'A cable', ar: 'كابل' },
              width: null,
              height: null,
            },
          ],
        },
        'ar',
      );

      expect(result.images[0]?.alt).toBe('كابل');
    });

    it('is empty for a product with no media', () => {
      expect(view().images).toEqual([]);
    });
  });

  describe('variants', () => {
    const twoSizes = {
      optionNames: ['Size'],
      variants: [
        variant({ sku: 'S', options: [{ name: 'Size', value: 'Small' }], price: usd(1999) }),
        variant({ sku: 'L', options: [{ name: 'Size', value: 'Large' }], price: usd(2999) }),
      ],
    };

    it('carries every variant with its options', () => {
      const result = view(twoSizes);
      expect(result.variants).toHaveLength(2);
      expect(result.variants[1]?.options).toEqual([{ name: 'Size', value: 'Large' }]);
    });

    it('names the option groups, so the dialog can render a picker', () => {
      expect(view(twoSizes).optionNames).toEqual(['Size']);
    });

    it('defaults to the cheapest, so the quoted price is never a surprise', () => {
      // The dearest variant listed first must not become the opening price.
      const result = view({
        optionNames: ['Size'],
        variants: [
          variant({ sku: 'L', options: [{ name: 'Size', value: 'Large' }], price: usd(2999) }),
          variant({ sku: 'S', options: [{ name: 'Size', value: 'Small' }], price: usd(1999) }),
        ],
      });

      expect(result.defaultSku).toBe('S');
    });

    it('reports prices as integer cents, never formatted', () => {
      // Formatting needs a locale AND a currency; the dialog does that at the
      // point of display, where both are known.
      expect(view().variants[0]?.priceCents).toBe(1999);
      expect(view().currency).toBe('USD');
    });
  });

  describe('offers', () => {
    it('carries a live offer with its expiry', () => {
      const result = view({
        variants: [variant({ compareAtPrice: usd(2499), offerEndsAt: LATER })],
      });

      expect(result.variants[0]?.compareAtCents).toBe(2499);
      expect(result.variants[0]?.offerEndsAt).toBe(LATER.toISOString());
    });

    it('drops an offer that has already ended', () => {
      /*
       * Applied here, against the SERVER clock. A device with a wrong date must
       * not be able to show a discount that ended last month — the customer
       * would be quoted a price the business did not intend, at the door, in
       * cash.
       */
      const result = view({
        variants: [variant({ compareAtPrice: usd(2499), offerEndsAt: EARLIER })],
      });

      expect(result.variants[0]?.compareAtCents).toBeNull();
      expect(result.variants[0]?.offerEndsAt).toBeNull();
    });

    it('treats the exact expiry moment as ended', () => {
      const result = view({
        variants: [variant({ compareAtPrice: usd(2499), offerEndsAt: NOW })],
      });
      expect(result.variants[0]?.compareAtCents).toBeNull();
    });

    it('reports no offer for a variant that has none', () => {
      expect(view().variants[0]?.compareAtCents).toBeNull();
      expect(view().variants[0]?.offerEndsAt).toBeNull();
    });

    it('reports no offer for a was-price with no end date', () => {
      // The domain refuses to store this, so it should be unreachable — but the
      // type permits it, and a half-formed offer must read as no offer rather
      // than as a discount with no stated expiry, which is the thing consumer
      // protection rules actually prohibit.
      const result = view({
        variants: [variant({ compareAtPrice: usd(2499), offerEndsAt: null })],
      });
      expect(result.variants[0]?.compareAtCents).toBeNull();
    });

    it('carries offers per variant, not per product', () => {
      const result = view({
        optionNames: ['Size'],
        variants: [
          variant({
            sku: 'S',
            options: [{ name: 'Size', value: 'Small' }],
            compareAtPrice: usd(2499),
            offerEndsAt: LATER,
          }),
          variant({ sku: 'L', options: [{ name: 'Size', value: 'Large' }], price: usd(2999) }),
        ],
      });

      expect(result.variants[0]?.compareAtCents).toBe(2499);
      expect(result.variants[1]?.compareAtCents).toBeNull();
    });
  });

  describe('availability', () => {
    const twoSizes = {
      optionNames: ['Size'],
      variants: [
        variant({ sku: 'S', options: [{ name: 'Size', value: 'Small' }], price: usd(1999) }),
        variant({ sku: 'L', options: [{ name: 'Size', value: 'Large' }], price: usd(2999) }),
      ],
    };

    it('reads a SKU with no entry as in stock', () => {
      // The catalogue does not know what stock is. Absent means uncounted, which
      // the inventory module treats as available — not as sold out.
      expect(view().variants[0]?.availability).toBe('in_stock');
    });

    it('carries what the caller supplies, per variant', () => {
      const result = view(twoSizes, 'en', new Map([['S', 'out_of_stock']]));

      expect(result.variants[0]?.availability).toBe('out_of_stock');
      expect(result.variants[1]?.availability).toBe('in_stock');
    });

    it('opens on the cheapest variant that can actually be bought', () => {
      // Opening on a sold-out variant quotes a price the customer cannot have
      // and makes the dialog's first impression a disabled button.
      const result = view(twoSizes, 'en', new Map([['S', 'out_of_stock']]));
      expect(result.defaultSku).toBe('L');
    });

    it('still prefers the cheapest when several are available', () => {
      const result = view(twoSizes, 'en', new Map());
      expect(result.defaultSku).toBe('S');
    });

    it('falls back to the cheapest overall when nothing is in stock', () => {
      // The price shown must still match the tile the customer clicked.
      const result = view(
        twoSizes,
        'en',
        new Map([
          ['S', 'out_of_stock'],
          ['L', 'out_of_stock'],
        ]),
      );
      expect(result.defaultSku).toBe('S');
    });
  });

  it('produces something structuredClone can carry to the browser', () => {
    // The reason this exists at all: a Product holds Money and Date objects, and
    // either of them leaking here would be rejected at the wire or reshaped.
    const result = view({
      media: [
        {
          kind: 'image',
          url: 'https://cdn.example/a.jpg',
          alt: englishOnly('A cable'),
          width: null,
          height: null,
        },
      ],
      variants: [variant({ compareAtPrice: usd(2499), offerEndsAt: LATER })],
    });

    expect(() => structuredClone(result)).not.toThrow();
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
