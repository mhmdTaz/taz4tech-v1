import type { PricedCart, PricedLine } from '@modules/cart';
import type { EntityId } from '@platform/ids';
import type { Region } from '@platform/regions';
import { err, ok } from '@platform/result';
import { describe, expect, it, vi } from 'vitest';
import type { OrderRepository, StockLedger } from '../contracts';
import type { Order } from '../domain/order';
import { makePlaceOrder, type PlaceOrderInput } from './place-order';

const NOW = new Date('2026-08-27T10:00:00Z');

const pricedLine = (overrides: Partial<PricedLine> = {}): PricedLine => {
  const quantity = overrides.quantity ?? 2;
  const unitPriceCents = overrides.unitPriceCents ?? 1999;
  return {
    sku: 'SKU-1',
    quantity,
    title: 'Anker Cable',
    href: '/en/products/anker-cable?variant=SKU-1',
    slug: 'anker-cable',
    imageUrl: null,
    imageAlt: '',
    options: [],
    unitPriceCents,
    compareAtCents: null,
    lineTotalCents: unitPriceCents * quantity,
    problem: null,
    ...overrides,
  };
};

const priced = (overrides: Partial<PricedCart> = {}): PricedCart => {
  const lines = overrides.lines ?? [pricedLine()];
  return {
    lines,
    removed: [],
    totalItems: lines.reduce((total, line) => total + line.quantity, 0),
    subtotalCents: lines.reduce((total, line) => total + line.lineTotalCents, 0),
    currency: 'USD',
    hasProblems: false,
    ...overrides,
  };
};

const input = (overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput => ({
  cart: { lines: [{ sku: 'SKU-1', quantity: 2 }] },
  locale: 'en',
  name: 'Rana K',
  phone: '03 123 456',
  region: 'beirut',
  city: 'Beirut',
  street: 'Hamra St',
  notes: '',
  idempotencyKey: 'checkout-1',
  ...overrides,
});

const repository = (overrides: Partial<OrderRepository> = {}): OrderRepository => ({
  findById: vi.fn(async () => null),
  findByNumber: vi.fn(async () => null),
  findByIdempotencyKey: vi.fn(async () => null),
  list: vi.fn(async () => ({ orders: [], nextCursor: null })),
  save: vi.fn(async () => ok(undefined)),
  updateStatus: vi.fn(async () => null),
  nextSequence: vi.fn(async () => 42),
  ...overrides,
});

let counter = 0;

const placer = (
  options: {
    repository?: OrderRepository;
    cart?: PricedCart;
    take?: StockLedger['take'];
    deliveryFeeCents?: number;
    /** What delivery costs, per governorate, when the flat number is not enough. */
    fees?: Partial<Record<Region, number>>;
  } = {},
) => {
  counter = 0;
  const take = vi.fn(options.take ?? (async () => ok(undefined)));
  const giveBack = vi.fn(async () => undefined);
  const repo = options.repository ?? repository();

  /*
   * Region-aware, deliberately.
   *
   * A fake that ignored its argument would let the region silently stop reaching
   * the port and every test here would still pass — with every order in the
   * country charged whatever Beirut costs.
   */
  const deliveryFeeCents = vi.fn(
    async (region: Region) => options.fees?.[region] ?? options.deliveryFeeCents ?? 300,
  );

  return {
    take,
    giveBack,
    deliveryFeeCents,
    repository: repo,
    place: makePlaceOrder({
      repository: repo,
      priceCart: vi.fn(async () => options.cart ?? priced()),
      stock: { take, giveBack },
      deliveryFeeCents,
      storeId: 'taz4tech',
      now: () => NOW,
      nextId: () => `ORDER${String(++counter).padStart(21, '0')}` as EntityId<'Order'>,
    }),
  };
};

const placed = async (harness: ReturnType<typeof placer>, overrides = {}): Promise<Order> => {
  const result = await harness.place(input(overrides));
  if (!result.ok) throw new Error(`expected an order, got ${result.error.tag}`);
  return result.value;
};

describe('placing an order', () => {
  it('creates one from a priced cart', async () => {
    const order = await placed(placer());

    expect(order.number).toBe('T4T-26-000042');
    expect(order.status).toBe('pending');
    expect(order.lines).toHaveLength(1);
  });

  it('normalises the phone number on the way in', async () => {
    // The phone number is the customer identity. Two records for one customer
    // because one was typed "03 123 456" is the failure this prevents.
    const order = await placed(placer());
    expect(order.customer.phone).toBe('+9613123456');
  });

  it('prices from the CATALOGUE at the moment of ordering', async () => {
    // The cart cookie carries no money at all; this is the only place the
    // amounts come from, and it runs moments before the write.
    const order = await placed(placer());

    expect(order.subtotal.cents).toBe(3998);
    expect(order.deliveryFee.cents).toBe(300);
    expect(order.total.cents).toBe(4298);
  });

  it('SNAPSHOTS the line rather than referencing the product', async () => {
    // Change a price tomorrow and yesterday's order must still say what was
    // agreed. That is the whole point of an order.
    const order = await placed(
      placer({ cart: priced({ lines: [pricedLine({ title: 'Anker Cable (2m)' })] }) }),
    );

    expect(order.lines[0]?.title).toBe('Anker Cable (2m)');
    expect(order.lines[0]?.unitPrice.cents).toBe(1999);
    expect(order.lines[0]?.lineTotal.cents).toBe(3998);
  });

  it('snapshots the variant options, which is how a picking slip says WHICH one', async () => {
    // "Anker Cable" is not enough to pick from a shelf; "Black, 2m" is.
    const order = await placed(
      placer({
        cart: priced({
          lines: [
            pricedLine({
              options: [
                { name: 'Colour', value: 'Black' },
                { name: 'Length', value: '2m' },
              ],
            }),
          ],
        }),
      }),
    );

    expect(order.lines[0]?.options).toEqual([
      { name: 'Colour', value: 'Black' },
      { name: 'Length', value: '2m' },
    ]);
  });

  it('records the region, which is what delivery will eventually be priced on', async () => {
    const order = await placed(placer(), { region: 'akkar' });
    expect(order.delivery.region).toBe('akkar');
  });

  it('keeps a delivery note, and treats a blank one as none', async () => {
    expect((await placed(placer(), { notes: ' ring twice ' })).delivery.notes).toBe('ring twice');
    expect((await placed(placer(), { notes: '   ' })).delivery.notes).toBeNull();
  });

  it('applies a zero delivery fee without inventing one', async () => {
    const order = await placed(placer({ deliveryFeeCents: 0 }));
    expect(order.total.cents).toBe(order.subtotal.cents);
  });

  it('asks what delivery costs TO THIS GOVERNORATE', async () => {
    const harness = placer();
    await placed(harness, { region: 'akkar' });

    expect(harness.deliveryFeeCents).toHaveBeenCalledWith('akkar');
  });

  it('charges the price of the governorate it is going to', async () => {
    // Beirut is not Akkar. An order that took the wrong row of the table would
    // still be a valid order, which is why this is asserted on the total.
    const harness = placer({ fees: { beirut: 200, akkar: 800 } });

    const near = await placed(harness, { region: 'beirut' });
    const far = await placed(harness, { region: 'akkar' });

    expect(near.deliveryFee.cents).toBe(200);
    expect(far.deliveryFee.cents).toBe(800);
    expect(far.total.cents - near.total.cents).toBe(600);
  });
});

describe('refusing to place one', () => {
  it('refuses an empty cart', async () => {
    const result = await placer({ cart: priced({ lines: [] }) }).place(input());
    expect(result).toEqual({ ok: false, error: { tag: 'cart_empty' } });
  });

  it('refuses a cart whose contents changed underneath it', async () => {
    // A price rose, an offer expired, a product was archived, the last one sold.
    // The customer has to see the new cart before agreeing to it.
    const changed = priced({ hasProblems: true });
    const result = await placer({ cart: changed }).place(input());

    expect(result).toEqual({ ok: false, error: { tag: 'cart_changed' } });
  });

  it('refuses a phone number it cannot read', async () => {
    const result = await placer().place(input({ phone: 'call me' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('phone_invalid');
  });

  it('refuses a region that is not one of the eight', async () => {
    const result = await placer().place(input({ region: 'Mount Lebanon' }));
    expect(result).toEqual({
      ok: false,
      error: { tag: 'region_invalid', region: 'Mount Lebanon' },
    });
  });

  it('refuses an empty name without touching stock', async () => {
    const harness = placer();
    const result = await harness.place(input({ name: '   ' }));

    expect(result.ok).toBe(false);
    // The order is validated only after stock is taken, so the rollback is what
    // keeps this true — and it is worth asserting rather than assuming.
    expect(harness.giveBack).toHaveBeenCalledWith('SKU-1', 2);
  });

  it('checks the customer BEFORE it touches anything else', async () => {
    // Cheap checks first: a bad phone number must not cost a stock movement or
    // an order number.
    const harness = placer();
    await harness.place(input({ phone: 'nope' }));

    expect(harness.take).not.toHaveBeenCalled();
    expect(harness.repository.nextSequence).not.toHaveBeenCalled();
  });
});

describe('taking the stock', () => {
  it('takes exactly what was ordered, per line', async () => {
    const harness = placer({
      cart: priced({
        lines: [pricedLine({ sku: 'A', quantity: 2 }), pricedLine({ sku: 'B', quantity: 1 })],
      }),
    });
    await placed(harness);

    expect(harness.take).toHaveBeenCalledWith('A', 2);
    expect(harness.take).toHaveBeenCalledWith('B', 1);
  });

  it('treats an UNTRACKED sku as sold, not as unavailable', async () => {
    // Untracked means nobody counts it, which means it sells freely. Reading
    // that as a failure would block orders for everything uncounted.
    const order = await placed(placer({ take: async () => err({ tag: 'untracked' as const }) }));

    expect(order.lines).toHaveLength(1);
  });

  it('refuses when the last one went, and says how many are left', async () => {
    const result = await placer({
      take: async () => err({ tag: 'insufficient' as const, onHand: 1 }),
    }).place(input());

    expect(result).toEqual({
      ok: false,
      error: { tag: 'out_of_stock', sku: 'SKU-1', available: 1 },
    });
  });

  it('reports zero available when the failure did not say how many', async () => {
    // A refusal with no count still has to produce a number the page can render;
    // zero is the safe reading of "not enough".
    const result = await placer({
      take: async () => err({ tag: 'insufficient' as const, onHand: 0 }),
    }).place(input());

    expect(result).toEqual({
      ok: false,
      error: { tag: 'out_of_stock', sku: 'SKU-1', available: 0 },
    });
  });

  it('GIVES BACK what it already took when a later line fails', async () => {
    /*
     * The compensation that stands in for a transaction. Without it, a checkout
     * that fails on its second line silently consumes the first line's stock —
     * and nothing anywhere would ever put it back.
     */
    const harness = placer({
      take: async (sku) =>
        sku === 'B' ? err({ tag: 'insufficient' as const, onHand: 0 }) : ok(undefined),
      cart: priced({
        lines: [pricedLine({ sku: 'A', quantity: 2 }), pricedLine({ sku: 'B', quantity: 1 })],
      }),
    });

    const result = await harness.place(input());

    expect(result.ok).toBe(false);
    expect(harness.take).toHaveBeenCalledWith('A', 2);
    expect(harness.giveBack).toHaveBeenCalledWith('A', 2);
  });

  it('gives back nothing it never took', async () => {
    const harness = placer({ take: async () => err({ tag: 'insufficient' as const, onHand: 0 }) });
    await harness.place(input());

    // The one failed take, and no compensating give-back for a line that was
    // never taken in the first place.
    expect(harness.take).toHaveBeenCalledTimes(1);
    expect(harness.giveBack).not.toHaveBeenCalled();
  });

  it('survives a rollback that itself fails', async () => {
    /*
     * If putting stock back throws, there is nothing further this code can do
     * about it — and turning that into a 500 would replace a recoverable
     * miscount with a checkout that looks broken to the customer, on a request
     * that was already being refused for a different reason.
     */
    const harness = placer({
      take: async (sku) =>
        sku === 'B' ? err({ tag: 'insufficient' as const, onHand: 0 }) : ok(undefined),
      cart: priced({
        lines: [pricedLine({ sku: 'A', quantity: 1 }), pricedLine({ sku: 'B', quantity: 1 })],
      }),
    });
    harness.giveBack.mockRejectedValue(new Error('mongo went away'));

    const result = await harness.place(input());

    expect(result).toMatchObject({ ok: false, error: { tag: 'out_of_stock', sku: 'B' } });
  });

  it('takes stock BEFORE burning an order number', async () => {
    const harness = placer({ take: async () => err({ tag: 'insufficient' as const, onHand: 0 }) });
    await harness.place(input());

    // A failed checkout must not leave a gap in the numbering.
    expect(harness.repository.nextSequence).not.toHaveBeenCalled();
  });

  it('gives stock back when the order itself turns out invalid', async () => {
    const harness = placer();
    await harness.place(input({ city: '   ' }));

    expect(harness.take).toHaveBeenCalledWith('SKU-1', 2);
    expect(harness.giveBack).toHaveBeenCalledWith('SKU-1', 2);
  });
});

describe('a double-tapped checkout', () => {
  it('returns the order already placed rather than an error', async () => {
    /*
     * The customer tapped twice on a slow connection. The unique index refused
     * the second write, which is exactly what it is for — and the right answer
     * is the order they already have, not a message about having placed it.
     */
    const existing = { number: 'T4T-26-000041' } as Order;
    const repo = repository({
      save: vi.fn(async () => err({ tag: 'duplicate_checkout' as const, idempotencyKey: 'k' })),
      findByIdempotencyKey: vi.fn(async () => existing),
    });

    const result = await placer({ repository: repo }).place(input());
    expect(result).toEqual({ ok: true, value: existing });
  });

  it('gives back the stock the second attempt took', async () => {
    // The first attempt already took its own; leaving this one's taken would
    // double-count the sale.
    const repo = repository({
      save: vi.fn(async () => err({ tag: 'duplicate_checkout' as const, idempotencyKey: 'k' })),
      findByIdempotencyKey: vi.fn(async () => ({ number: 'T4T-26-000041' }) as Order),
    });

    const harness = placer({ repository: repo });
    await harness.place(input());
    expect(harness.giveBack).toHaveBeenCalledWith('SKU-1', 2);
  });

  it('throws when the duplicate order cannot be found afterwards', async () => {
    // The index says one exists and the read says it does not. Something is
    // genuinely wrong; returning "your order was placed" without an order would
    // send the customer away with nothing.
    const repo = repository({
      save: vi.fn(async () => err({ tag: 'duplicate_checkout' as const, idempotencyKey: 'k' })),
      findByIdempotencyKey: vi.fn(async () => null),
    });

    await expect(placer({ repository: repo }).place(input())).rejects.toThrow(/refused/);
  });

  it('throws on a duplicate NUMBER, which means the counter is wrong', async () => {
    // Not something to paper over: the counter and the collection disagree, and
    // quietly retrying would hand two customers one number.
    const repo = repository({
      save: vi.fn(async () => err({ tag: 'duplicate_number' as const, number: 'T4T-26-000042' })),
    });

    await expect(placer({ repository: repo }).place(input())).rejects.toThrow(/refused/);
  });
});
