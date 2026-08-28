import type { EntityId } from '@platform/ids';
import { englishOnly } from '@platform/locale';
import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { describe, expect, it } from 'vitest';
import { applyBulkOperation, isValidBasisPoints, MAX_BASIS_POINTS } from './bulk-edit';
import type { Product, Variant } from './product';

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
  title: englishOnly('Anker Cable'),
  description: englishOnly('A cable.'),
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

/** Narrow to the changed product, failing loudly rather than returning undefined. */
const changed = (outcome: ReturnType<typeof applyBulkOperation>): Product => {
  if (outcome.tag !== 'changed') throw new Error(`expected a change, got ${outcome.tag}`);
  return outcome.product;
};

describe('set_status', () => {
  it('changes the status', () => {
    const result = applyBulkOperation(product(), { tag: 'set_status', status: 'archived' }, NOW);
    expect(changed(result).status).toBe('archived');
  });

  it('reports no change when the status already matches', () => {
    // Not "changed with the same value": writing it would move updatedAt, which
    // the storefront sorts and caches on, for nothing at all.
    const result = applyBulkOperation(product(), { tag: 'set_status', status: 'active' }, NOW);
    expect(result).toEqual({ tag: 'unchanged' });
  });

  it('stamps updatedAt from the clock it is given', () => {
    const result = applyBulkOperation(product(), { tag: 'set_status', status: 'draft' }, NOW);
    expect(changed(result).updatedAt).toEqual(NOW);
  });

  it('leaves createdAt alone', () => {
    const result = applyBulkOperation(product(), { tag: 'set_status', status: 'draft' }, NOW);
    expect(changed(result).createdAt).toEqual(EARLIER);
  });
});

describe('set_brand', () => {
  it('sets a brand', () => {
    const result = applyBulkOperation(product(), { tag: 'set_brand', brand: 'Belkin' }, NOW);
    expect(changed(result).brand).toBe('Belkin');
  });

  it('clears a brand with null', () => {
    const result = applyBulkOperation(product(), { tag: 'set_brand', brand: null }, NOW);
    expect(changed(result).brand).toBeNull();
  });

  it('trims, so a stray space is not a different brand', () => {
    // "Anker " and "Anker" would otherwise be two brands in the facet list.
    const result = applyBulkOperation(product(), { tag: 'set_brand', brand: '  Belkin  ' }, NOW);
    expect(changed(result).brand).toBe('Belkin');
  });

  it('treats a blank brand as no brand', () => {
    // A whitespace brand reads as present to anything that only checks for null,
    // and renders as an empty chip on the storefront.
    const result = applyBulkOperation(product(), { tag: 'set_brand', brand: '   ' }, NOW);
    expect(changed(result).brand).toBeNull();
  });

  it('reports no change when trimming lands on the current value', () => {
    const result = applyBulkOperation(product(), { tag: 'set_brand', brand: ' Anker ' }, NOW);
    expect(result).toEqual({ tag: 'unchanged' });
  });

  it('reports no change when clearing an already-absent brand', () => {
    const result = applyBulkOperation(
      product({ brand: null }),
      { tag: 'set_brand', brand: null },
      NOW,
    );
    expect(result).toEqual({ tag: 'unchanged' });
  });
});

describe('scale_price', () => {
  it('raises every variant', () => {
    const result = applyBulkOperation(
      product({
        optionNames: ['Length'],
        variants: [
          variant({ sku: 'A', options: [{ name: 'Length', value: '1m' }], price: usd(1999) }),
          variant({ sku: 'B', options: [{ name: 'Length', value: '2m' }], price: usd(2999) }),
        ],
      }),
      { tag: 'scale_price', basisPoints: 10_500 },
      NOW,
    );

    expect(changed(result).variants.map((v) => v.price.cents)).toEqual([2099, 3149]);
  });

  it('lowers prices below 10000', () => {
    const result = applyBulkOperation(product(), { tag: 'scale_price', basisPoints: 9_000 }, NOW);
    expect(changed(result).variants[0]?.price.cents).toBe(1799);
  });

  it('reports no change at exactly 10000', () => {
    const result = applyBulkOperation(product(), { tag: 'scale_price', basisPoints: 10_000 }, NOW);
    expect(result).toEqual({ tag: 'unchanged' });
  });

  it('reports no change when rounding lands back on the same cents', () => {
    // A one-cent item raised 0.01% is still one cent. Writing it would be a
    // pointless update disguised as a price change.
    const result = applyBulkOperation(
      product({ variants: [variant({ price: usd(1) })] }),
      { tag: 'scale_price', basisPoints: 10_001 },
      NOW,
    );
    expect(result).toEqual({ tag: 'unchanged' });
  });

  describe('the was-price', () => {
    const onOffer = product({
      variants: [variant({ price: usd(1999), compareAtPrice: usd(2499), offerEndsAt: LATER })],
    });

    it('is left exactly where it was', () => {
      // A was-price is a claim about history. Scaling it in step would keep the
      // advertised discount looking identical while rewriting what the product
      // used to cost — on the field consumer protection rules care about.
      const result = applyBulkOperation(onOffer, { tag: 'scale_price', basisPoints: 10_500 }, NOW);

      expect(changed(result).variants[0]?.price.cents).toBe(2099);
      expect(changed(result).variants[0]?.compareAtPrice?.cents).toBe(2499);
    });

    it('refuses the product when the new price would meet it', () => {
      // $19.99 raised 25% is $24.99, which is exactly the was-price: a discount
      // of zero, advertised as a discount.
      const result = applyBulkOperation(onOffer, { tag: 'scale_price', basisPoints: 12_501 }, NOW);

      expect(result).toMatchObject({
        tag: 'refused',
        reason: { tag: 'invalid_result', reason: { tag: 'compare_at_not_higher' } },
      });
    });

    it('refuses the product when the new price would pass it', () => {
      const result = applyBulkOperation(onOffer, { tag: 'scale_price', basisPoints: 20_000 }, NOW);
      expect(result.tag).toBe('refused');
    });

    it('still allows a rise that keeps the discount real', () => {
      const result = applyBulkOperation(onOffer, { tag: 'scale_price', basisPoints: 11_000 }, NOW);
      expect(changed(result).variants[0]?.price.cents).toBe(2199);
    });
  });

  it('refuses rather than writing a price it cannot represent exactly', () => {
    const result = applyBulkOperation(
      product({ variants: [variant({ price: usd(Number.MAX_SAFE_INTEGER) })] }),
      { tag: 'scale_price', basisPoints: MAX_BASIS_POINTS },
      NOW,
    );
    expect(result).toEqual({
      tag: 'refused',
      reason: { tag: 'price_unrepresentable', sku: 'SKU-1' },
    });
  });

  it('takes a price to zero at 0 basis points, which the domain still allows', () => {
    // Guarded in the UI by isValidBasisPoints rather than here: the domain has
    // no opinion on a free product, and inventing one would be this file
    // deciding commercial policy.
    const result = applyBulkOperation(product(), { tag: 'scale_price', basisPoints: 0 }, NOW);
    expect(changed(result).variants[0]?.price.cents).toBe(0);
  });
});

describe('clear_offer', () => {
  const expired = product({
    variants: [variant({ price: usd(1999), compareAtPrice: usd(2499), offerEndsAt: EARLIER })],
  });

  it('removes the was-price and the end date together', () => {
    const result = applyBulkOperation(expired, { tag: 'clear_offer' }, NOW);
    expect(changed(result).variants[0]?.compareAtPrice).toBeNull();
    expect(changed(result).variants[0]?.offerEndsAt).toBeNull();
  });

  it('is no longer the only way to touch a product whose offer has ended', () => {
    /*
     * This used to be the point of the operation: an expired offer left a
     * product in a state createProduct refused, so every other bulk operation
     * on it was refused too and this was the one that got it unstuck.
     *
     * The domain clears an expired offer instead of refusing it now, so any
     * operation works — which is the friction that went away. `clear_offer`
     * keeps its real job: ending an offer that is still running.
     */
    expect(applyBulkOperation(expired, { tag: 'set_status', status: 'draft' }, NOW).tag).toBe(
      'changed',
    );
  });

  it('reports no change for a product that has no offer', () => {
    expect(applyBulkOperation(product(), { tag: 'clear_offer' }, NOW)).toEqual({
      tag: 'unchanged',
    });
  });

  it('clears a live offer too, which is how an offer is ended early', () => {
    const live = product({
      variants: [variant({ price: usd(1999), compareAtPrice: usd(2499), offerEndsAt: LATER })],
    });
    expect(
      changed(applyBulkOperation(live, { tag: 'clear_offer' }, NOW)).variants[0],
    ).toMatchObject({ compareAtPrice: null, offerEndsAt: null });
  });

  it('clears every variant, not only the ones on offer', () => {
    const mixed = product({
      optionNames: ['Length'],
      variants: [
        variant({
          sku: 'A',
          options: [{ name: 'Length', value: '1m' }],
          compareAtPrice: usd(2499),
          offerEndsAt: LATER,
        }),
        variant({ sku: 'B', options: [{ name: 'Length', value: '2m' }] }),
      ],
    });

    expect(
      changed(applyBulkOperation(mixed, { tag: 'clear_offer' }, NOW)).variants.every(
        (v) => v.compareAtPrice === null && v.offerEndsAt === null,
      ),
    ).toBe(true);
  });
});

describe('a product already in an invalid state', () => {
  /*
   * An expired offer used to be this example, and it is not one any more — the
   * domain clears it rather than refusing it. A was-price at or below the
   * current price still is: that is a discount of zero advertised as a discount,
   * which is a claim about money rather than a stale date, and no amount of time
   * passing makes it true.
   */
  const stale = product({
    variants: [variant({ price: usd(2499), compareAtPrice: usd(2499), offerEndsAt: LATER })],
  });

  it('is refused by an operation that would change it', () => {
    const result = applyBulkOperation(stale, { tag: 'set_status', status: 'draft' }, NOW);
    expect(result).toMatchObject({
      tag: 'refused',
      reason: { tag: 'invalid_result', reason: { tag: 'compare_at_not_higher' } },
    });
  });

  it('is reported as unchanged, not refused, by an operation that is a no-op', () => {
    // The order matters: checking "did anything change?" before revalidating
    // means a stale product does not turn every unrelated no-op into an error
    // the operator has to read past.
    const result = applyBulkOperation(stale, { tag: 'set_status', status: 'active' }, NOW);
    expect(result).toEqual({ tag: 'unchanged' });
  });
});

describe('isValidBasisPoints', () => {
  it.each([
    [1, true],
    [10_000, true],
    [MAX_BASIS_POINTS, true],
    [0, false],
    [-500, false],
    [MAX_BASIS_POINTS + 1, false],
    [10_500.5, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
  ])('%s -> %s', (value, expected) => {
    expect(isValidBasisPoints(value)).toBe(expected);
  });
});
