import type { Product, Variant } from '@modules/catalog';
import type { StockLevel } from '@modules/inventory';
import type { EntityId } from '@platform/ids';
import { englishOnly } from '@platform/locale';
import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { describe, expect, it, vi } from 'vitest';
import type { Cart } from '../domain/cart';
import { makePriceCart } from './price-cart';

const NOW = new Date('2026-08-27T10:00:00Z');
const LATER = new Date('2026-12-31T10:00:00Z');
const EARLIER = new Date('2026-01-01T10:00:00Z');

const usd = (cents: number) => unwrapOrThrow(fromCents(cents));

const variant = (sku: string, overrides: Partial<Variant> = {}): Variant => ({
  sku,
  options: [],
  price: usd(1999),
  compareAtPrice: null,
  offerEndsAt: null,
  barcode: null,
  weightGrams: null,
  ...overrides,
});

const product = (slug: string, overrides: Partial<Product> = {}): Product => ({
  storeId: 'taz4tech',
  id: 'PRODUCT0000000000000001AA' as EntityId<'Product'>,
  slug,
  title: { en: 'Anker Cable', ar: 'كابل انكر' },
  description: englishOnly('A cable.'),
  brand: 'Anker',
  status: 'active',
  optionNames: [],
  variants: [variant('SKU-1')],
  media: [],
  specs: [],
  createdAt: EARLIER,
  updatedAt: EARLIER,
  ...overrides,
});

const level = (sku: string, overrides: Partial<StockLevel> = {}): StockLevel => ({
  storeId: 'taz4tech',
  sku,
  policy: 'tracked',
  onHand: 10,
  updatedAt: NOW,
  ...overrides,
});

const cart = (...lines: [string, number][]): Cart => ({
  lines: lines.map(([sku, quantity]) => ({ sku, quantity })),
});

const price = (
  products: ReadonlyMap<string, Product>,
  levels: ReadonlyMap<string, StockLevel> = new Map(),
) =>
  makePriceCart({
    products: vi.fn(async () => products),
    stock: vi.fn(async () => levels),
    now: () => NOW,
  });

describe('an empty cart', () => {
  it('prices to zero without asking the database anything', async () => {
    const products = vi.fn(async () => new Map());
    const stock = vi.fn(async () => new Map());
    const result = await makePriceCart({ products, stock, now: () => NOW })({ lines: [] }, 'en');

    expect(result.subtotalCents).toBe(0);
    expect(result.totalItems).toBe(0);
    expect(result.hasProblems).toBe(false);
    // The arrays too. A page renders these, and "no lines" has to mean none.
    expect(result.lines).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(products).not.toHaveBeenCalled();
    expect(stock).not.toHaveBeenCalled();
  });
});

describe('pricing', () => {
  const oneProduct = new Map([['SKU-1', product('anker-cable')]]);

  it('reads the price from the CATALOGUE, never from the cart', async () => {
    // The cookie holds SKUs and quantities and nothing else, precisely so that
    // a customer cannot set the price by editing it.
    const result = await price(oneProduct)(cart(['SKU-1', 3]), 'en');

    expect(result.lines[0]?.unitPriceCents).toBe(1999);
    expect(result.lines[0]?.lineTotalCents).toBe(5997);
  });

  it('sums in integer cents, so a subtotal is never a rounding', async () => {
    const products = new Map([
      ['SKU-1', product('a', { variants: [variant('SKU-1', { price: usd(1999) })] })],
      ['SKU-2', product('b', { variants: [variant('SKU-2', { price: usd(333) })] })],
    ]);

    const result = await price(products)(cart(['SKU-1', 3], ['SKU-2', 7]), 'en');
    expect(result.subtotalCents).toBe(1999 * 3 + 333 * 7);
  });

  it('counts items, not lines', async () => {
    const result = await price(oneProduct)(cart(['SKU-1', 4]), 'en');
    expect(result.totalItems).toBe(4);
  });

  it('carries the details a line needs to be recognisable', async () => {
    const products = new Map([
      [
        'SKU-1',
        product('anker-cable', {
          optionNames: ['Length'],
          media: [
            {
              kind: 'image',
              url: 'https://cdn.example/a.jpg',
              alt: englishOnly('A cable'),
              width: null,
              height: null,
            },
          ],
          variants: [variant('SKU-1', { options: [{ name: 'Length', value: '2m' }] })],
        }),
      ],
    ]);

    const line = (await price(products)(cart(['SKU-1', 1]), 'en')).lines[0];
    expect(line?.title).toBe('Anker Cable');
    expect(line?.options).toEqual([{ name: 'Length', value: '2m' }]);
    expect(line?.imageUrl).toBe('https://cdn.example/a.jpg');
    expect(line?.imageAlt).toBe('A cable');
  });

  it('links back to the exact variant, not just the product', async () => {
    // The customer clicking a cart line expects the thing they chose, already
    // selected — the product page reads the variant from the query string.
    const line = (await price(oneProduct)(cart(['SKU-1', 1]), 'en')).lines[0];
    expect(line?.href).toBe('/en/products/anker-cable?variant=SKU-1');
  });

  it('escapes a SKU that would otherwise break the link', async () => {
    const products = new Map([['A B&C', product('anker-cable', { variants: [variant('A B&C')] })]]);
    const line = (await price(products)(cart(['A B&C', 1]), 'en')).lines[0];
    expect(line?.href).toContain('variant=A%20B%26C');
  });

  it('translates the title', async () => {
    const line = (await price(oneProduct)(cart(['SKU-1', 1]), 'ar')).lines[0];
    expect(line?.title).toBe('كابل انكر');
  });

  it('has no image url for a product with no media', async () => {
    const line = (await price(oneProduct)(cart(['SKU-1', 1]), 'en')).lines[0];
    expect(line?.imageUrl).toBeNull();
    // And no alt text either: a cart thumbnail with no image needs no label.
    expect(line?.imageAlt).toBe('');
  });

  it('takes the first IMAGE, not the first media item', async () => {
    // Media holds videos too. Taking whatever comes first puts a video URL in
    // an <img> on the cart page, which renders as a broken thumbnail.
    const withVideo = new Map([
      [
        'SKU-1',
        product('a', {
          media: [
            {
              kind: 'video',
              url: '/v.mp4',
              alt: englishOnly('A video'),
              width: null,
              height: null,
            },
            {
              kind: 'image',
              url: '/p.png',
              alt: englishOnly('A photo'),
              width: null,
              height: null,
            },
          ],
        }),
      ],
    ]);
    const line = (await price(withVideo)(cart(['SKU-1', 1]), 'en')).lines[0];

    expect(line?.imageUrl).toBe('/p.png');
    expect(line?.imageAlt).toBe('A photo');
  });

  it('prices the variant the customer chose, not the first or the cheapest', async () => {
    /*
     * The line that decides what somebody is charged. A product with two
     * variants, a cart naming the DEARER one: take the first variant instead,
     * or fall back to the cheapest, and the customer is quoted a price they did
     * not pick — undercharged here, which is the direction nobody reports.
     */
    const twoVariants = new Map([
      [
        'SKU-BIG',
        product('a', {
          variants: [variant('SKU-SMALL'), variant('SKU-BIG', { price: usd(4999) })],
        }),
      ],
    ]);
    const line = (await price(twoVariants)(cart(['SKU-BIG', 2]), 'en')).lines[0];

    expect(line?.unitPriceCents).toBe(4999);
    expect(line?.lineTotalCents).toBe(9998);
  });

  it('falls back to the cheapest variant if a SKU does not belong to its product', async () => {
    // Defensive: the lookup this consumes maps only SKUs it was asked for, but
    // the dependency is a plain function and a caller could hand over anything.
    const mismatched = new Map([['SKU-9', product('a', { variants: [variant('SKU-1')] })]]);
    const line = (await price(mismatched)(cart(['SKU-9', 1]), 'en')).lines[0];

    expect(line?.unitPriceCents).toBe(1999);
  });
});

describe('offers', () => {
  it('shows a live was-price', async () => {
    const products = new Map([
      [
        'SKU-1',
        product('a', {
          variants: [variant('SKU-1', { compareAtPrice: usd(2499), offerEndsAt: LATER })],
        }),
      ],
    ]);

    expect((await price(products)(cart(['SKU-1', 1]), 'en')).lines[0]?.compareAtCents).toBe(2499);
  });

  it('drops an offer that has already ended', async () => {
    // Against the SERVER clock. A cart left open past the end of a sale must not
    // still be quoting it.
    const products = new Map([
      [
        'SKU-1',
        product('a', {
          variants: [variant('SKU-1', { compareAtPrice: usd(2499), offerEndsAt: EARLIER })],
        }),
      ],
    ]);

    expect((await price(products)(cart(['SKU-1', 1]), 'en')).lines[0]?.compareAtCents).toBeNull();
  });

  it('shows nothing for a variant with no offer', async () => {
    const products = new Map([['SKU-1', product('a')]]);
    expect((await price(products)(cart(['SKU-1', 1]), 'en')).lines[0]?.compareAtCents).toBeNull();
  });
});

describe('a line that no longer resolves', () => {
  it('is reported rather than dropped in silence', async () => {
    // A cart that quietly shrinks is a customer wondering what they forgot.
    const result = await price(new Map())(cart(['GONE', 2]), 'en');

    expect(result.lines).toEqual([]);
    expect(result.removed).toEqual([{ sku: 'GONE', quantity: 2 }]);
    expect(result.hasProblems).toBe(true);
  });

  it('does not stop the rest of the cart pricing', async () => {
    const products = new Map([['SKU-1', product('a')]]);
    const result = await price(products)(cart(['GONE', 1], ['SKU-1', 2]), 'en');

    expect(result.lines).toHaveLength(1);
    expect(result.subtotalCents).toBe(1999 * 2);
    expect(result.removed).toHaveLength(1);
  });

  it('is not counted in the totals', async () => {
    const result = await price(new Map())(cart(['GONE', 5]), 'en');
    expect(result.totalItems).toBe(0);
    expect(result.subtotalCents).toBe(0);
  });
});

describe('stock', () => {
  const products = new Map([['SKU-1', product('a')]]);

  it('reports no problem when there is enough', async () => {
    const levels = new Map([['SKU-1', level('SKU-1', { onHand: 5 })]]);
    expect((await price(products, levels)(cart(['SKU-1', 5]), 'en')).lines[0]?.problem).toBeNull();
  });

  it('reports how many are actually available', async () => {
    const levels = new Map([['SKU-1', level('SKU-1', { onHand: 2 })]]);
    const result = await price(products, levels)(cart(['SKU-1', 5]), 'en');

    expect(result.lines[0]?.problem).toEqual({ tag: 'not_enough', available: 2 });
    expect(result.hasProblems).toBe(true);
  });

  it('reports zero for a tracked SKU that has run out', async () => {
    const levels = new Map([['SKU-1', level('SKU-1', { onHand: 0 })]]);
    expect((await price(products, levels)(cart(['SKU-1', 1]), 'en')).lines[0]?.problem).toEqual({
      tag: 'not_enough',
      available: 0,
    });
  });

  it('reports nothing for an UNCOUNTED SKU, however many are wanted', async () => {
    // No record means nobody counts it, which is not the same as none left.
    expect((await price(products)(cart(['SKU-1', 99]), 'en')).lines[0]?.problem).toBeNull();
  });

  it('reports nothing for a SKU deliberately not counted', async () => {
    const levels = new Map([['SKU-1', level('SKU-1', { policy: 'untracked', onHand: 0 })]]);
    expect((await price(products, levels)(cart(['SKU-1', 9]), 'en')).lines[0]?.problem).toBeNull();
  });

  it('still prices a line it cannot fulfil', async () => {
    // The customer needs to see what it costs and decide; a line with no price
    // is a line they cannot reason about.
    const levels = new Map([['SKU-1', level('SKU-1', { onHand: 1 })]]);
    const result = await price(products, levels)(cart(['SKU-1', 4]), 'en');

    expect(result.lines[0]?.lineTotalCents).toBe(1999 * 4);
  });

  it('RESERVES nothing', async () => {
    // Reserving at add-to-cart would let anyone empty a shop by filling a cart,
    // and a COD shop with one operator has no basket expiry to release them.
    const stock = vi.fn(async () => new Map());
    await makePriceCart({ products: vi.fn(async () => products), stock, now: () => NOW })(
      cart(['SKU-1', 1]),
      'en',
    );

    // Read once, written never — the port has no way to write at all.
    expect(stock).toHaveBeenCalledOnce();
  });
});

describe('hasProblems', () => {
  /*
   * The flag the cart page uses to decide whether to show a warning and whether
   * checkout is safe to offer. Asserted false only for an EMPTY cart until now,
   * which is the one case where every way of computing it agrees.
   */
  it('is false for a full cart with nothing wrong', async () => {
    const products = new Map([['SKU-1', product('a')]]);
    const result = await price(products, new Map([['SKU-1', level('SKU-1')]]))(
      cart(['SKU-1', 2]),
      'en',
    );

    expect(result.lines).toHaveLength(1);
    expect(result.hasProblems).toBe(false);
  });

  it('is true when only ONE of several lines has a problem', async () => {
    // Some, not every. Computed the other way round a cart is only "in trouble"
    // when every line is, so the one item that has run out is offered for
    // checkout alongside the ones that have not.
    const products = new Map([
      ['SKU-1', product('a')],
      ['SKU-2', product('b', { variants: [variant('SKU-2')] })],
    ]);
    const levels = new Map([
      ['SKU-1', level('SKU-1', { onHand: 10 })],
      ['SKU-2', level('SKU-2', { onHand: 0 })],
    ]);
    const result = await price(products, levels)(cart(['SKU-1', 1], ['SKU-2', 1]), 'en');

    expect(result.lines.filter((line) => line.problem !== null)).toHaveLength(1);
    expect(result.hasProblems).toBe(true);
  });
});

describe('the two lookups', () => {
  it('asks for products and stock together rather than one after the other', async () => {
    const order: string[] = [];
    const products = vi.fn(async () => {
      order.push('products:start');
      await Promise.resolve();
      order.push('products:end');
      return new Map([['SKU-1', product('a')]]);
    });
    const stock = vi.fn(async () => {
      order.push('stock:start');
      return new Map();
    });

    await makePriceCart({ products, stock, now: () => NOW })(cart(['SKU-1', 1]), 'en');

    // Stock starts before products finishes: a cart page that waits for one and
    // then the other is a page that waits twice.
    expect(order.indexOf('stock:start')).toBeLessThan(order.indexOf('products:end'));
  });

  it('asks about every SKU in the cart', async () => {
    const products = vi.fn(async () => new Map());
    const stock = vi.fn(async () => new Map());
    await makePriceCart({ products, stock, now: () => NOW })(cart(['A', 1], ['B', 2]), 'en');

    expect(products).toHaveBeenCalledWith(['A', 'B']);
    expect(stock).toHaveBeenCalledWith(['A', 'B']);
  });
});
