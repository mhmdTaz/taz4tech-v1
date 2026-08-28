import { fromCents } from '@platform/money';
import { ok, unwrapOrThrow } from '@platform/result';
import { describe, expect, it, vi } from 'vitest';
import type { ListOrdersQuery, OrderRepository, StockLedger } from '../contracts';
import type { Order, OrderLine, OrderStatus } from '../domain/order';
import {
  DEFAULT_ORDER_PAGE,
  MAX_ORDER_PAGE,
  makeListOrders,
  makeUpdateOrderStatus,
} from './update-order-status';

const NOW = new Date('2026-08-27T10:00:00Z');
const ID = 'ORDER00000000000000001AA';
const usd = (cents: number) => unwrapOrThrow(fromCents(cents));

const aLine = (sku: string, quantity: number): OrderLine => ({
  sku,
  title: 'Anker Cable',
  options: [],
  quantity,
  unitPrice: usd(1999),
  lineTotal: usd(1999 * quantity),
});

const order = (overrides: Partial<Order> = {}): Order => ({
  storeId: 'taz4tech',
  id: ID,
  number: 'T4T-26-000001',
  status: 'pending',
  customer: { name: 'Rana K', phone: '+9613123456' },
  locale: 'en',
  delivery: { region: 'beirut', city: 'Beirut', street: 'Hamra St', notes: null },
  lines: [aLine('SKU-1', 2)],
  subtotal: usd(3998),
  deliveryFee: usd(0),
  total: usd(3998),
  idempotencyKey: 'k',
  placedAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const harness = (options: { current?: Order | null; updated?: Order | null } = {}) => {
  const current = options.current === undefined ? order() : options.current;
  const findById = vi.fn(async () => current);
  const updateStatus = vi.fn(async (_s: string, _i: string, _f: OrderStatus, to: OrderStatus) =>
    options.updated === undefined
      ? current === null
        ? null
        : { ...current, status: to }
      : options.updated,
  );

  const repository = {
    findById,
    findByNumber: vi.fn(async () => null),
    findByIdempotencyKey: vi.fn(async () => null),
    list: vi.fn(async () => ({ orders: [], nextCursor: null })),
    save: vi.fn(async () => ok(undefined)),
    updateStatus,
    nextSequence: vi.fn(async () => 1),
  } satisfies OrderRepository;

  const stock: StockLedger = {
    take: vi.fn(async () => ok(undefined)),
    giveBack: vi.fn(async () => undefined),
  };

  return {
    repository,
    stock,
    updateStatus,
    findById,
    run: makeUpdateOrderStatus({ repository, stock, storeId: 'taz4tech', now: () => NOW }),
  };
};

describe('moving an order along', () => {
  it('confirms a pending order', async () => {
    const h = harness();
    const result = await h.run(ID, 'pending', 'confirmed');

    expect(result.ok).toBe(true);
    expect(h.updateStatus).toHaveBeenCalledWith('taz4tech', ID, 'pending', 'confirmed', NOW);
  });

  it('marks a confirmed order delivered', async () => {
    const h = harness({ current: order({ status: 'confirmed' }) });
    expect((await h.run(ID, 'confirmed', 'delivered')).ok).toBe(true);
  });

  it('refuses a transition the lifecycle does not allow', async () => {
    // pending -> delivered skips the call the operator makes before shipping.
    const h = harness();
    expect(await h.run(ID, 'pending', 'delivered')).toEqual({
      ok: false,
      error: { tag: 'not_allowed', from: 'pending', to: 'delivered' },
    });
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('refuses to move a delivered order at all', async () => {
    const h = harness({ current: order({ status: 'delivered' }) });
    expect((await h.run(ID, 'delivered', 'cancelled')).ok).toBe(false);
  });

  it('reports an order that is not there', async () => {
    const h = harness({ current: null });
    expect(await h.run('missing', 'pending', 'confirmed')).toEqual({
      ok: false,
      error: { tag: 'not_found' },
    });
  });

  it("puts the SCREEN's status into the write, so the write can refuse it", async () => {
    // The guard is the filter, not a check before it.
    const h = harness({ current: order({ status: 'confirmed' }) });
    await h.run(ID, 'confirmed', 'delivered');

    expect(h.updateStatus.mock.calls[0]?.[2]).toBe('confirmed');
  });
});

describe('when somebody else moved it first', () => {
  it('says so when the screen was rendered from a status the order has left', async () => {
    /*
     * The common shape of the race: a page left open on a pending order while
     * another operator confirmed it. Answering "pending -> confirmed is not
     * allowed" would be true of the order as it is now and would read as an
     * accusation about a button that was perfectly legal when it was drawn.
     */
    const h = harness({ current: order({ status: 'confirmed' }) });

    expect(await h.run(ID, 'pending', 'confirmed')).toEqual({
      ok: false,
      error: { tag: 'already_moved', current: 'confirmed' },
    });
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('says so when the order moves between the read and the write', async () => {
    // The narrow window the conditional write exists to close.
    const h = harness({ updated: null, current: order() });
    h.findById.mockResolvedValueOnce(order()).mockResolvedValueOnce(order({ status: 'cancelled' }));

    expect(await h.run(ID, 'pending', 'confirmed')).toEqual({
      ok: false,
      error: { tag: 'already_moved', current: 'cancelled' },
    });
  });

  it('reports not_found when the order vanished between the two reads', async () => {
    // Nothing in this system deletes an order, so this is defence rather than a
    // path with a caller. It is here because the alternative — reporting the
    // status it USED to have — states a fact about a record that is gone.
    const h = harness({ updated: null, current: order() });
    h.findById.mockResolvedValueOnce(order()).mockResolvedValueOnce(null);

    expect(await h.run(ID, 'pending', 'confirmed')).toEqual({
      ok: false,
      error: { tag: 'not_found' },
    });
  });

  it('does NOT give stock back', async () => {
    // The whole reason the flip comes first. Two operators cancelling the same
    // order must credit the shelf once, not twice.
    const h = harness({ updated: null, current: order() });
    await h.run(ID, 'pending', 'cancelled');

    expect(h.stock.giveBack).not.toHaveBeenCalled();
  });

  it('does NOT give stock back for a stale screen either', async () => {
    // Two operators both looking at a pending order, one cancels. The second is
    // refused before the write is even attempted, so the shelf is credited once.
    const h = harness({ current: order({ status: 'cancelled' }) });
    await h.run(ID, 'pending', 'cancelled');

    expect(h.stock.giveBack).not.toHaveBeenCalled();
  });
});

describe('cancelling', () => {
  it('gives back every line', async () => {
    const h = harness({ current: order({ lines: [aLine('A', 2), aLine('B', 1)] }) });

    await h.run(ID, 'pending', 'cancelled');

    expect(h.stock.giveBack).toHaveBeenCalledWith('A', 2);
    expect(h.stock.giveBack).toHaveBeenCalledWith('B', 1);
  });

  it('gives stock back from a CONFIRMED order too', async () => {
    // It was taken when the order was placed, whatever has happened since.
    const h = harness({ current: order({ status: 'confirmed' }) });
    await h.run(ID, 'confirmed', 'cancelled');

    expect(h.stock.giveBack).toHaveBeenCalledWith('SKU-1', 2);
  });

  it('gives nothing back when the order never held any', async () => {
    // Unreachable through the lifecycle today — cancelled is terminal — but the
    // decision is made from the status the order HAD, not from the one it is
    // being moved to, and that is worth pinning.
    const h = harness({ current: order({ status: 'cancelled' }) });
    const result = await h.run(ID, 'cancelled', 'cancelled');

    expect(result.ok).toBe(false);
    expect(h.stock.giveBack).not.toHaveBeenCalled();
  });

  it('gives nothing back when merely confirming', async () => {
    const h = harness();
    await h.run(ID, 'pending', 'confirmed');

    expect(h.stock.giveBack).not.toHaveBeenCalled();
  });

  it('still cancels when returning stock fails', async () => {
    // The order is already cancelled by then. Turning a failed credit into an
    // error would leave the operator staring at a cancellation that looks like
    // it did not happen — and it did.
    const h = harness();
    (h.stock.giveBack as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gone'));

    expect((await h.run(ID, 'pending', 'cancelled')).ok).toBe(true);
  });
});

describe('listing orders', () => {
  const lister = () => {
    const list = vi.fn(async (_query: ListOrdersQuery) => ({
      orders: [] as Order[],
      nextCursor: null as string | null,
    }));
    const repository = { ...harness().repository, list } satisfies OrderRepository;
    return { list, run: makeListOrders({ repository, storeId: 'taz4tech' }) };
  };

  it('defaults to a page size', async () => {
    const { list, run } = lister();
    await run({});
    expect(list.mock.calls[0]?.[0]).toMatchObject({ limit: DEFAULT_ORDER_PAGE });
  });

  it('CLAMPS an absurd page size rather than refusing', async () => {
    // An internal screen. An operator fiddling with a query string wants a page,
    // not an error.
    const { list, run } = lister();
    await run({ limit: 100_000 });
    expect(list.mock.calls[0]?.[0]).toMatchObject({ limit: MAX_ORDER_PAGE });
  });

  it('clamps zero and negative up to one', async () => {
    const { list, run } = lister();
    await run({ limit: 0 });
    expect(list.mock.calls[0]?.[0]).toMatchObject({ limit: DEFAULT_ORDER_PAGE });

    await run({ limit: -5 });
    expect(list.mock.calls[1]?.[0]).toMatchObject({ limit: 1 });
  });

  it('passes a status filter through', async () => {
    const { list, run } = lister();
    await run({ status: 'pending' });
    expect(list.mock.calls[0]?.[0]).toMatchObject({ status: 'pending' });
  });

  it('omits an empty cursor rather than paging from nowhere', async () => {
    const { list, run } = lister();
    await run({ cursor: '' });
    expect(list.mock.calls[0]?.[0]).not.toHaveProperty('cursor');
  });

  it('passes a real cursor through', async () => {
    const { list, run } = lister();
    await run({ cursor: 'ORDER123' });
    expect(list.mock.calls[0]?.[0]).toMatchObject({ cursor: 'ORDER123' });
  });
});

describe('finding a customer by phone', () => {
  const lister = () => {
    const list = vi.fn(async (_query: ListOrdersQuery) => ({
      orders: [] as Order[],
      nextCursor: null as string | null,
    }));
    const repository = { ...harness().repository, list } satisfies OrderRepository;
    return { list, run: makeListOrders({ repository, storeId: 'taz4tech' }) };
  };

  it('normalises what the operator typed before looking', async () => {
    /*
     * The operator types what the customer says. Orders store one shape,
     * because every one of them went in through the same normaliser — so the
     * search has to go through it too, or the number on the screen never
     * matches the number in the database.
     */
    const { list, run } = lister();
    const result = await run({ phone: '03 123 456' });

    expect(list.mock.calls[0]?.[0]).toMatchObject({ phone: '+9613123456' });
    expect(result.phone).toEqual({ tag: 'searched', e164: '+9613123456' });
  });

  it('finds the same orders however the number was written', async () => {
    const { list, run } = lister();
    await run({ phone: '+961 3 123 456' });
    await run({ phone: '03123456' });

    expect(list.mock.calls[0]?.[0]).toMatchObject({ phone: '+9613123456' });
    expect(list.mock.calls[1]?.[0]).toMatchObject({ phone: '+9613123456' });
  });

  it('does not ask the database for a number it could not read', async () => {
    // An unreadable number cannot match a stored one, so a query for it is a
    // query for nothing — and "unreadable" is a different sentence from "none
    // found", which matters when somebody is on the phone.
    const { list, run } = lister();
    const result = await run({ phone: 'the guy from yesterday' });

    expect(list).not.toHaveBeenCalled();
    expect(result).toEqual({
      orders: [],
      nextCursor: null,
      phone: { tag: 'unreadable', input: 'the guy from yesterday' },
    });
  });

  it('treats a blank box as no search at all', async () => {
    const { list, run } = lister();
    const result = await run({ phone: '   ' });

    expect(list.mock.calls[0]?.[0]).not.toHaveProperty('phone');
    expect(result.phone).toEqual({ tag: 'none' });
  });

  it('combines with a status filter rather than replacing it', async () => {
    const { list, run } = lister();
    await run({ phone: '03 123 456', status: 'pending' });

    expect(list.mock.calls[0]?.[0]).toMatchObject({ phone: '+9613123456', status: 'pending' });
  });

  it('refuses a number this shop could never have stored', async () => {
    // Checkout only accepts Lebanese numbers, so a foreign one matches nothing
    // by construction — saying so beats an empty page.
    const { run } = lister();
    expect((await run({ phone: '+44 20 7123 4567' })).phone.tag).toBe('unreadable');
  });
});
