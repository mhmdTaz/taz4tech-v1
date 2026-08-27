import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { type Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scansCollection, usesIndex, winningStages } from '@/test-support/explain';
import type { Order } from '../domain/order';
import {
  COUNTERS_COLLECTION,
  createMongoOrderRepository,
  ensureOrderIndexes,
  ORDERS_COLLECTION,
} from './mongo-order-repository';

const URI = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_TEST_DB ?? 'taz4tech_test';

let client: MongoClient;
let db: Db;

const NOW = new Date('2026-08-27T10:00:00Z');
const usd = (cents: number) => unwrapOrThrow(fromCents(cents));

const order = (n: number, overrides: Partial<Order> = {}): Order => ({
  storeId: 'taz4tech',
  id: `ORDER${String(n).padStart(21, '0')}`,
  number: `T4T-26-${String(n).padStart(6, '0')}`,
  status: 'pending',
  customer: { name: 'Rana K', phone: '+9613123456' },
  delivery: { region: 'beirut', city: 'Beirut', street: 'Hamra St', notes: null },
  lines: [
    {
      sku: 'SKU-1',
      title: 'Anker Cable',
      options: [{ name: 'Length', value: '2m' }],
      quantity: 2,
      unitPrice: usd(1999),
      lineTotal: usd(3998),
    },
  ],
  subtotal: usd(3998),
  deliveryFee: usd(300),
  total: usd(4298),
  idempotencyKey: `checkout-${n}`,
  placedAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

beforeAll(async () => {
  client = await MongoClient.connect(URI);
  db = client.db(DB_NAME);
});

afterAll(async () => {
  await db
    .collection(ORDERS_COLLECTION)
    .drop()
    .catch(() => undefined);
  await db
    .collection(COUNTERS_COLLECTION)
    .drop()
    .catch(() => undefined);
  await client.close();
});

beforeEach(async () => {
  await db.collection(ORDERS_COLLECTION).deleteMany({});
  await db.collection(COUNTERS_COLLECTION).deleteMany({});
  await ensureOrderIndexes(db);
});

describe('save and read', () => {
  it('round-trips an order, money and all', async () => {
    const repository = createMongoOrderRepository(db);
    expect((await repository.save(order(1))).ok).toBe(true);

    expect(await repository.findByNumber('taz4tech', 'T4T-26-000001')).toEqual(order(1));
  });

  it('finds an order by the number spoken on the phone', async () => {
    const repository = createMongoOrderRepository(db);
    await repository.save(order(7));

    expect((await repository.findByNumber('taz4tech', 'T4T-26-000007'))?.id).toBe(order(7).id);
  });

  it('never crosses tenants', async () => {
    const repository = createMongoOrderRepository(db);
    await repository.save(order(1, { storeId: 'tenant-a' }));

    expect(await repository.findByNumber('tenant-b', 'T4T-26-000001')).toBeNull();
  });

  it('refuses to hand back an order it cannot read', async () => {
    // An order is the record of a transaction. A document edited by hand during
    // an incident must fail loudly rather than become a total nobody can explain
    // at the door.
    await db.collection(ORDERS_COLLECTION).insertOne({
      ...(order(9) as unknown as Record<string, unknown>),
      _id: order(9).id as never,
      total: { cents: 'lots', currency: 'USD' },
    });

    await expect(
      createMongoOrderRepository(db).findByNumber('taz4tech', 'T4T-26-000009'),
    ).rejects.toThrow(/Unreadable order document/);
  });
});

describe('the order number counter', () => {
  it('starts at one', async () => {
    expect(await createMongoOrderRepository(db).nextSequence('taz4tech', 2026)).toBe(1);
  });

  it('never hands out the same number twice, even under load', async () => {
    /*
     * The reason it is a conditional update rather than a count.
     *
     * Two customers checking out in the same second must not be handed one
     * number — it is spoken on the phone and printed on a box, and two orders
     * sharing one would be unresolvable at the door.
     */
    const repository = createMongoOrderRepository(db);
    const issued = await Promise.all(
      Array.from({ length: 50 }, () => repository.nextSequence('taz4tech', 2026)),
    );

    expect(new Set(issued).size).toBe(50);
    expect(Math.max(...issued)).toBe(50);
  });

  it('resets per year without colliding with last year', async () => {
    const repository = createMongoOrderRepository(db);
    await repository.nextSequence('taz4tech', 2026);
    await repository.nextSequence('taz4tech', 2026);

    expect(await repository.nextSequence('taz4tech', 2027)).toBe(1);
  });

  it('counts separately per store', async () => {
    const repository = createMongoOrderRepository(db);
    await repository.nextSequence('tenant-a', 2026);

    expect(await repository.nextSequence('tenant-b', 2026)).toBe(1);
  });
});

describe('a double-tapped checkout', () => {
  it('is refused by the unique index, not by a check that could be raced', async () => {
    const repository = createMongoOrderRepository(db);
    await repository.save(order(1, { idempotencyKey: 'same-tap' }));

    const second = await repository.save(order(2, { idempotencyKey: 'same-tap' }));

    expect(second).toEqual({
      ok: false,
      error: { tag: 'duplicate_checkout', idempotencyKey: 'same-tap' },
    });
  });

  it('leaves exactly one order behind', async () => {
    const repository = createMongoOrderRepository(db);
    await repository.save(order(1, { idempotencyKey: 'same-tap' }));
    await repository.save(order(2, { idempotencyKey: 'same-tap' }));

    expect(await db.collection(ORDERS_COLLECTION).countDocuments({})).toBe(1);
  });

  it('lets the first order be found by its key afterwards', async () => {
    // Which is what turns the refusal into "here is the order you already
    // placed" rather than an error.
    const repository = createMongoOrderRepository(db);
    await repository.save(order(1, { idempotencyKey: 'same-tap' }));

    expect((await repository.findByIdempotencyKey('taz4tech', 'same-tap'))?.number).toBe(
      'T4T-26-000001',
    );
  });

  it('survives only ONE of many simultaneous attempts', async () => {
    const repository = createMongoOrderRepository(db);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        repository.save(order(i + 1, { idempotencyKey: 'one-tap' })),
      ),
    );

    expect(attempts.filter((result) => result.ok)).toHaveLength(1);
    expect(await db.collection(ORDERS_COLLECTION).countDocuments({})).toBe(1);
  });

  it('reports a duplicate NUMBER distinctly from a duplicate checkout', async () => {
    // They mean different things: one is a customer tapping twice, the other is
    // the counter and the collection disagreeing.
    const repository = createMongoOrderRepository(db);
    await repository.save(order(1));

    const clash = await repository.save(order(2, { number: 'T4T-26-000001' }));
    expect(clash).toEqual({
      ok: false,
      error: { tag: 'duplicate_number', number: 'T4T-26-000001' },
    });
  });
});

describe('listing', () => {
  it('returns the newest first', async () => {
    const repository = createMongoOrderRepository(db);
    for (let i = 1; i <= 3; i++) await repository.save(order(i));

    const page = await repository.list({ storeId: 'taz4tech', limit: 10 });
    expect(page.orders.map((each) => each.number)).toEqual([
      'T4T-26-000003',
      'T4T-26-000002',
      'T4T-26-000001',
    ]);
  });

  it('filters by status', async () => {
    const repository = createMongoOrderRepository(db);
    await repository.save(order(1));
    await repository.save(order(2, { status: 'confirmed' }));

    const page = await repository.list({ storeId: 'taz4tech', status: 'confirmed', limit: 10 });
    expect(page.orders.map((each) => each.number)).toEqual(['T4T-26-000002']);
  });

  it('pages with a cursor rather than an offset', async () => {
    // An order arriving between pages must not shift a row across the boundary
    // the way skip/limit would.
    const repository = createMongoOrderRepository(db);
    for (let i = 1; i <= 5; i++) await repository.save(order(i));

    const first = await repository.list({ storeId: 'taz4tech', limit: 2 });
    expect(first.nextCursor).not.toBeNull();

    const second = await repository.list({
      storeId: 'taz4tech',
      limit: 2,
      cursor: first.nextCursor ?? '',
    });

    expect(second.orders.map((each) => each.number)).toEqual(['T4T-26-000003', 'T4T-26-000002']);
  });

  it('reports no cursor on the last page', async () => {
    const repository = createMongoOrderRepository(db);
    await repository.save(order(1));

    expect((await repository.list({ storeId: 'taz4tech', limit: 10 })).nextCursor).toBeNull();
  });

  it('never crosses tenants', async () => {
    const repository = createMongoOrderRepository(db);
    await repository.save(order(1, { storeId: 'tenant-a' }));

    expect((await repository.list({ storeId: 'tenant-b', limit: 10 })).orders).toEqual([]);
  });

  it('uses an index rather than scanning', async () => {
    const repository = createMongoOrderRepository(db);
    await repository.save(order(1));

    const explain = await db
      .collection(ORDERS_COLLECTION)
      .find({ storeId: 'taz4tech', status: 'pending' })
      .sort({ _id: -1 })
      .explain();
    const stages = winningStages(explain);

    expect(scansCollection(stages), stages.join(', ')).toBe(false);
    expect(usesIndex(stages), stages.join(', ')).toBe(true);
  });

  it('finds a customer by phone without scanning', async () => {
    // "What did this number order?" is the question the operator asks on every
    // call, so it has an index of its own.
    const repository = createMongoOrderRepository(db);
    await repository.save(order(1));

    const explain = await db
      .collection(ORDERS_COLLECTION)
      .find({ storeId: 'taz4tech', 'customer.phone': '+9613123456' })
      .sort({ _id: -1 })
      .explain();

    expect(scansCollection(winningStages(explain))).toBe(false);
  });
});
