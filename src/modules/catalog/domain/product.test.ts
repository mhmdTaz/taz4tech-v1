import { englishOnly } from '@platform/locale';
import { fromCents, type Money } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { describe, expect, it } from 'vitest';
import {
  createProduct,
  defaultVariant,
  findVariant,
  hasPriceRange,
  isOnOffer,
  isPurchasable,
  isValidSlug,
  optionValues,
  PRODUCT_STATUSES,
  type Product,
  priceRange,
  slugify,
  type Variant,
} from './product';

const NOW = new Date('2026-08-27T10:00:00Z');
const LATER = new Date('2026-09-27T10:00:00Z');
const EARLIER = new Date('2026-07-27T10:00:00Z');

const usd = (cents: number): Money => unwrapOrThrow(fromCents(cents));

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
  title: englishOnly('Lenovo IdeaPad 3'),
  description: englishOnly('A laptop.'),
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

/** A two-axis product: Colour x Storage. */
const withOptions = (): Product =>
  product({
    optionNames: ['Colour', 'Storage'],
    variants: [
      variant({
        sku: 'IP3-BLK-256',
        options: [
          { name: 'Colour', value: 'Black' },
          { name: 'Storage', value: '256GB' },
        ],
        price: usd(129900),
      }),
      variant({
        sku: 'IP3-BLK-512',
        options: [
          { name: 'Colour', value: 'Black' },
          { name: 'Storage', value: '512GB' },
        ],
        price: usd(149900),
      }),
      variant({
        sku: 'IP3-SLV-256',
        options: [
          { name: 'Colour', value: 'Silver' },
          { name: 'Storage', value: '256GB' },
        ],
        price: usd(119900),
      }),
    ],
  });

describe('slugs', () => {
  it.each([
    ['Lenovo IdeaPad 3', 'lenovo-ideapad-3'],
    ['  ASUS   ROG  ', 'asus-rog'],
    ['HP 15" Laptop -- 256GB!!', 'hp-15-laptop-256gb'],
    ['iPhone 15 Pro', 'iphone-15-pro'],
  ])('slugifies %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('strips accents rather than dropping the letter', () => {
    // NFKD splits "é" into "e" + combining mark; the mark is removed, the e stays.
    expect(slugify('Café Latté')).toBe('cafe-latte');
  });

  it('produces an empty slug for text with no latin characters', () => {
    // Arabic titles cannot form a latin slug. The caller must supply one, which
    // is why createProduct rejects an empty slug rather than silently accepting.
    expect(slugify('حاسوب محمول')).toBe('');
    expect(isValidSlug(slugify('حاسوب محمول'))).toBe(false);
  });

  it('never ends with a hyphen, even when truncated at the limit', () => {
    // 119 letters then a space: the slug is 119 a's, a hyphen at index 119, and
    // more after it — so the cut at SLUG_MAX lands ON the hyphen. That is the
    // only way the final trim has anything to do, and the difference between a
    // valid slug and one isValidSlug refuses.
    const long = slugify(`${'a'.repeat(119)} bbbb`);
    expect(long).toBe('a'.repeat(119));
    expect(isValidSlug(long)).toBe(true);
  });

  it('keeps the last word when the cut does not land on a hyphen', () => {
    const long = slugify(`${'a'.repeat(118)} bbbb`);
    expect(long).toBe(`${'a'.repeat(118)}-b`);
    expect(isValidSlug(long)).toBe(true);
  });

  it.each(['', '-leading', 'trailing-', 'double--hyphen', 'Upper', 'has space', 'sym!bol'])(
    'rejects %s as a slug',
    (slug) => {
      expect(isValidSlug(slug)).toBe(false);
    },
  );

  it('rejects a slug over the length limit', () => {
    expect(isValidSlug('a'.repeat(121))).toBe(false);
    expect(isValidSlug('a'.repeat(120))).toBe(true);
  });
});

describe('createProduct', () => {
  it('accepts a simple product with one variant and no options', () => {
    const result = createProduct(product(), NOW);
    expect(result.ok).toBe(true);
  });

  it('accepts a product with a full variant matrix', () => {
    expect(createProduct(withOptions(), NOW).ok).toBe(true);
  });

  it('trims the brand and nulls it when blank', () => {
    const trimmed = createProduct(product({ brand: '  Lenovo  ' }), NOW);
    if (trimmed.ok) expect(trimmed.value.brand).toBe('Lenovo');

    const blank = createProduct(product({ brand: '   ' }), NOW);
    if (blank.ok) expect(blank.value.brand).toBeNull();
  });

  it('rejects an invalid slug', () => {
    const result = createProduct(product({ slug: 'Not A Slug' }), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('slug_invalid');
  });

  it('rejects an empty title or description', () => {
    const noTitle = createProduct(product({ title: { en: '' } }), NOW);
    expect(noTitle.ok).toBe(false);
    if (!noTitle.ok) expect(noTitle.error.tag).toBe('title_invalid');

    const noDescription = createProduct(product({ description: { en: '  ' } }), NOW);
    expect(noDescription.ok).toBe(false);
    if (!noDescription.ok) expect(noDescription.error.tag).toBe('description_invalid');
  });

  it('rejects a product with no variants', () => {
    const result = createProduct(product({ variants: [] }), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('no_variants');
  });

  it('rejects an empty or duplicated SKU', () => {
    const empty = createProduct(product({ variants: [variant({ sku: '  ' })] }), NOW);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.tag).toBe('sku_empty');

    const duplicated = createProduct(
      product({
        optionNames: ['Colour'],
        variants: [
          variant({ sku: 'SAME', options: [{ name: 'Colour', value: 'Black' }] }),
          variant({ sku: 'SAME', options: [{ name: 'Colour', value: 'Silver' }] }),
        ],
      }),
      NOW,
    );
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.error.tag).toBe('sku_duplicated');
  });

  it('rejects duplicated or empty option names', () => {
    const duplicated = createProduct(product({ optionNames: ['Colour', 'Colour'] }), NOW);
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.error.tag).toBe('option_names_duplicated');

    const empty = createProduct(product({ optionNames: ['  '] }), NOW);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.tag).toBe('option_name_empty');
  });

  it('rejects a variant whose options do not match the declared axes', () => {
    const tooFew = createProduct(
      product({ optionNames: ['Colour', 'Storage'], variants: [variant({ options: [] })] }),
      NOW,
    );
    expect(tooFew.ok).toBe(false);
    if (!tooFew.ok) expect(tooFew.error.tag).toBe('variant_options_mismatch');

    const wrongName = createProduct(
      product({
        optionNames: ['Colour'],
        variants: [variant({ options: [{ name: 'Size', value: 'L' }] })],
      }),
      NOW,
    );
    expect(wrongName.ok).toBe(false);
    if (!wrongName.ok) expect(wrongName.error.tag).toBe('variant_options_mismatch');
  });

  it('rejects an empty option value', () => {
    const result = createProduct(
      product({
        optionNames: ['Colour'],
        variants: [variant({ options: [{ name: 'Colour', value: '  ' }] })],
      }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('variant_option_value_empty');
  });

  it('rejects two variants with the same option combination', () => {
    const result = createProduct(
      product({
        optionNames: ['Colour'],
        variants: [
          variant({ sku: 'A', options: [{ name: 'Colour', value: 'Black' }] }),
          variant({ sku: 'B', options: [{ name: 'Colour', value: 'Black' }] }),
        ],
      }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('variant_combination_duplicated');
  });

  it('rejects a negative price', () => {
    const result = createProduct(product({ variants: [variant({ price: usd(-1) })] }), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('price_negative');
  });

  it('accepts a free product', () => {
    expect(createProduct(product({ variants: [variant({ price: usd(0) })] }), NOW).ok).toBe(true);
  });

  describe('special offers', () => {
    it('accepts a discount with a future end date', () => {
      const result = createProduct(
        product({
          variants: [
            variant({ price: usd(99900), compareAtPrice: usd(129900), offerEndsAt: LATER }),
          ],
        }),
        NOW,
      );
      expect(result.ok).toBe(true);
    });

    it('rejects a discount with no end date', () => {
      // Lebanese consumer protection law requires every special offer to carry
      // an expiry date, so this is a legal requirement, not a UI preference.
      const result = createProduct(
        product({
          variants: [
            variant({ price: usd(99900), compareAtPrice: usd(129900), offerEndsAt: null }),
          ],
        }),
        NOW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('offer_without_end_date');
    });

    it('CLEARS an offer whose end date has passed, rather than refusing the product', () => {
      /*
       * This was an error until Phase 3.6, and it made every product unwritable
       * a month after its own promotion ended — an operator could not archive a
       * discontinued product or fix a typo in its title, because a date in the
       * past failed the whole write. `isOnOffer` already answered false for it,
       * so the storefront never showed the offer either way; clearing makes the
       * stored data agree with the page.
       */
      const result = createProduct(
        product({
          variants: [
            variant({ price: usd(99900), compareAtPrice: usd(129900), offerEndsAt: EARLIER }),
          ],
        }),
        NOW,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.variants[0]?.compareAtPrice).toBeNull();
        expect(result.value.variants[0]?.offerEndsAt).toBeNull();
      }
    });

    it('clears an offer ending exactly now, since it is already over', () => {
      const result = createProduct(
        product({
          variants: [variant({ price: usd(99900), compareAtPrice: usd(129900), offerEndsAt: NOW })],
        }),
        NOW,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.variants[0]?.offerEndsAt).toBeNull();
    });

    it('leaves a live offer exactly as it is', () => {
      // The normalisation must not touch an offer that has not ended: clearing a
      // running promotion would take a price off the storefront mid-campaign.
      const result = createProduct(
        product({
          variants: [
            variant({ price: usd(99900), compareAtPrice: usd(129900), offerEndsAt: LATER }),
          ],
        }),
        NOW,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.variants[0]?.compareAtPrice?.cents).toBe(129900);
        expect(result.value.variants[0]?.offerEndsAt).toEqual(LATER);
      }
    });

    it('rejects a compare-at price at or below the selling price', () => {
      for (const compareAt of [usd(99900), usd(50000)]) {
        const result = createProduct(
          product({
            variants: [
              variant({ price: usd(99900), compareAtPrice: compareAt, offerEndsAt: LATER }),
            ],
          }),
          NOW,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.tag).toBe('compare_at_not_higher');
      }
    });

    it('rejects an end date with no offer attached to it', () => {
      const result = createProduct(
        product({ variants: [variant({ compareAtPrice: null, offerEndsAt: LATER })] }),
        NOW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('offer_end_date_without_offer');
    });
  });

  it('rejects media with no URL or bad alt text', () => {
    const noUrl = createProduct(
      product({
        media: [
          { kind: 'image', url: '  ', alt: englishOnly('A laptop'), width: null, height: null },
        ],
      }),
      NOW,
    );
    expect(noUrl.ok).toBe(false);
    if (!noUrl.ok) expect(noUrl.error.tag).toBe('media_url_empty');

    const noAlt = createProduct(
      product({
        media: [{ kind: 'image', url: '/a.webp', alt: { en: '' }, width: null, height: null }],
      }),
      NOW,
    );
    expect(noAlt.ok).toBe(false);
    if (!noAlt.ok) expect(noAlt.error.tag).toBe('media_alt_invalid');
  });

  it('accepts valid media of both kinds', () => {
    const result = createProduct(
      product({
        media: [
          { kind: 'image', url: '/a.webp', alt: englishOnly('Front'), width: 800, height: 600 },
          { kind: 'video', url: '/a.mp4', alt: englishOnly('Hands on'), width: null, height: null },
        ],
      }),
      NOW,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a spec with an empty name or value', () => {
    const badName = createProduct(
      product({ specs: [{ name: { en: '' }, value: englishOnly('8GB'), group: null }] }),
      NOW,
    );
    expect(badName.ok).toBe(false);
    if (!badName.ok) expect(badName.error.tag).toBe('spec_invalid');

    const badValue = createProduct(
      product({ specs: [{ name: englishOnly('RAM'), value: { en: '  ' }, group: 'Memory' }] }),
      NOW,
    );
    expect(badValue.ok).toBe(false);
    if (!badValue.ok) expect(badValue.error.tag).toBe('spec_invalid');
  });

  it('accepts a valid spec table', () => {
    const result = createProduct(
      product({
        specs: [
          { name: englishOnly('RAM'), value: englishOnly('8 GB'), group: 'Memory' },
          { name: englishOnly('Weight'), value: englishOnly('1.6 kg'), group: null },
        ],
      }),
      NOW,
    );
    expect(result.ok).toBe(true);
  });
});

describe('reading a product', () => {
  it('picks the cheapest variant as the default, so the listed price is honest', () => {
    expect(defaultVariant(withOptions()).sku).toBe('IP3-SLV-256');
  });

  it('returns the only variant for a simple product', () => {
    expect(defaultVariant(product()).sku).toBe('SKU-1');
  });

  it('keeps the first of two variants that cost the same', () => {
    // Equal prices must not reorder the PDP. Whichever the operator listed
    // first is the one whose colour and photo the customer sees, and a tie
    // broken the other way would move it for no reason a customer can see.
    const tied = product({
      variants: [
        variant({ sku: 'FIRST', price: usd(99900) }),
        variant({ sku: 'SECOND', price: usd(99900) }),
      ],
    });
    expect(defaultVariant(tied).sku).toBe('FIRST');
  });

  it('reports the price range across variants', () => {
    const range = priceRange(withOptions());
    expect(range.from.cents).toBe(119900);
    expect(range.to.cents).toBe(149900);
    expect(hasPriceRange(withOptions())).toBe(true);
  });

  it('has no range when every variant costs the same', () => {
    expect(hasPriceRange(product())).toBe(false);
    const range = priceRange(product());
    expect(range.from.cents).toBe(range.to.cents);
  });

  it('lists distinct option values in first-seen order', () => {
    expect(optionValues(withOptions(), 'Colour')).toEqual(['Black', 'Silver']);
    expect(optionValues(withOptions(), 'Storage')).toEqual(['256GB', '512GB']);
    expect(optionValues(withOptions(), 'Nonexistent')).toEqual([]);
  });

  it('finds a variant by exact option selection', () => {
    const found = findVariant(withOptions(), [
      { name: 'Colour', value: 'Silver' },
      { name: 'Storage', value: '256GB' },
    ]);
    expect(found?.sku).toBe('IP3-SLV-256');
  });

  it('returns null for a combination that does not exist', () => {
    // Silver/512GB is a gap in the matrix — a real case, not an error.
    expect(
      findVariant(withOptions(), [
        { name: 'Colour', value: 'Silver' },
        { name: 'Storage', value: '512GB' },
      ]),
    ).toBeNull();
  });

  it('keeps two variants apart when one option value spells out another pair', () => {
    /*
     * Option lists are compared by joining them into one key, and the separator
     * is what stops "Colour=Black" + "Storage=256GB" from reading the same as a
     * single Colour of "Black|Storage=256GB". Without it the two variants below
     * collapse onto one key: the customer picking the second is quoted the
     * first one's price, and createProduct calls a legitimate matrix a
     * duplicate.
     *
     * Contrived on purpose — a supplier feed is where a value like this arrives.
     */
    const ambiguous = product({
      optionNames: ['Colour'],
      variants: [
        variant({
          sku: 'TWO-AXES',
          options: [
            { name: 'Colour', value: 'Black' },
            { name: 'Storage', value: '256GB' },
          ],
          price: usd(129900),
        }),
        variant({
          sku: 'ONE-AXIS',
          options: [{ name: 'Colour', value: 'BlackStorage=256GB' }],
          price: usd(99900),
        }),
      ],
    });

    expect(findVariant(ambiguous, [{ name: 'Colour', value: 'BlackStorage=256GB' }])?.sku).toBe(
      'ONE-AXIS',
    );
  });

  it('is purchasable only when active', () => {
    expect(isPurchasable(product({ status: 'active' }))).toBe(true);
    expect(isPurchasable(product({ status: 'draft' }))).toBe(false);
    expect(isPurchasable(product({ status: 'archived' }))).toBe(false);
  });

  it('knows every status', () => {
    expect([...PRODUCT_STATUSES]).toEqual(['draft', 'active', 'archived']);
  });
});

describe('isOnOffer', () => {
  const discounted = variant({
    price: usd(99900),
    compareAtPrice: usd(129900),
    offerEndsAt: LATER,
  });

  it('is on offer before the end date', () => {
    expect(isOnOffer(discounted, NOW)).toBe(true);
  });

  it('stops being on offer once the date passes, with no job required', () => {
    // Expiry is computed on read. A scheduled job that fails would otherwise
    // leave a stale discount live, quoting a price the business did not intend
    // to a customer paying cash at the door.
    expect(isOnOffer(discounted, new Date(LATER.getTime() + 1))).toBe(false);
  });

  it('is not on offer exactly at the end date', () => {
    expect(isOnOffer(discounted, LATER)).toBe(false);
  });

  it('is not on offer without a compare-at price', () => {
    expect(isOnOffer(variant(), NOW)).toBe(false);
  });

  /*
   * createProduct refuses a half-set offer, so these two shapes cannot be
   * written today. isOnOffer is still called on every variant read back from
   * Mongo, including documents written before that rule existed — and one of
   * these reads a date off null, which is a crashed product page rather than a
   * wrong price.
   */
  it('is not on offer with an end date but nothing to discount', () => {
    expect(isOnOffer(variant({ offerEndsAt: LATER }), NOW)).toBe(false);
  });

  it('is not on offer with a compare-at price and no end date', () => {
    expect(isOnOffer(variant({ compareAtPrice: usd(149900) }), NOW)).toBe(false);
  });
});
