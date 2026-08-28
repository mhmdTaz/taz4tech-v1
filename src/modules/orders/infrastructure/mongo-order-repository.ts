/**
 * Orders in MongoDB.
 *
 * Two things here are the reason this file is not trivial: the order NUMBER is
 * allocated by an atomic counter, and the idempotency key carries a unique
 * index. Both exist because two customers can press a button in the same
 * millisecond, and neither problem can be solved by reading first and then
 * writing.
 */

import { LOCALES } from '@platform/locale';
import type { Money } from '@platform/money';
import { fromCents } from '@platform/money';
import { REGIONS } from '@platform/regions';
import { err, ok, type Result } from '@platform/result';
import type { Collection, Db } from 'mongodb';
import { z } from 'zod';
import type { ListOrdersQuery, OrderConflict, OrderPage, OrderRepository } from '../contracts';
import { ORDER_STATUSES, type Order } from '../domain/order';

export const ORDERS_COLLECTION = 'orders';
export const COUNTERS_COLLECTION = 'counters';

const MONEY = z.object({ cents: z.number().int(), currency: z.literal('USD') });

const DocumentSchema = z.object({
  _id: z.string(),
  storeId: z.string().min(1),
  number: z.string().min(1),
  status: z.enum(ORDER_STATUSES),
  customer: z.object({ name: z.string().min(1), phone: z.string().min(1) }),
  // Defaulted, so an order written before this field existed still reads rather
  // than making the whole orders list unopenable.
  locale: z.enum(LOCALES).default('en'),
  delivery: z.object({
    region: z.enum(REGIONS),
    city: z.string().min(1),
    street: z.string().min(1),
    notes: z.string().nullable(),
  }),
  lines: z
    .array(
      z.object({
        sku: z.string().min(1),
        title: z.string(),
        options: z.array(z.object({ name: z.string(), value: z.string() })),
        quantity: z.number().int().min(1),
        unitPrice: MONEY,
        lineTotal: MONEY,
      }),
    )
    .min(1),
  subtotal: MONEY,
  deliveryFee: MONEY,
  total: MONEY,
  idempotencyKey: z.string().min(1),
  /*
   * Nullable and defaulted, because orders written before this field existed
   * have no token and their confirmation links are already in people's
   * messages. Reading one back as null is how the page knows to let it through;
   * see the note on Order.viewToken.
   */
  viewToken: z.string().min(1).nullable().default(null),
  placedAt: z.date(),
  updatedAt: z.date(),
});

type OrderDocument = z.infer<typeof DocumentSchema>;

const money = (value: { cents: number; currency: 'USD' }): Money => {
  const parsed = fromCents(value.cents, value.currency);
  if (!parsed.ok) throw new Error(`Unreadable amount in an order: ${value.cents}`);
  return parsed.value;
};

/**
 * Parsed on the way out, not trusted.
 *
 * An order is the record of a transaction. A document written by an older
 * version, or edited by hand during an incident, must fail loudly here rather
 * than become a total nobody can explain at the door.
 */
const toDomain = (document: unknown): Order => {
  const parsed = DocumentSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`Unreadable order document: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const data = parsed.data;

  return {
    storeId: data.storeId,
    id: data._id,
    number: data.number,
    status: data.status,
    customer: data.customer,
    locale: data.locale,
    delivery: data.delivery,
    lines: data.lines.map((line) => ({
      sku: line.sku,
      title: line.title,
      options: line.options,
      quantity: line.quantity,
      unitPrice: money(line.unitPrice),
      lineTotal: money(line.lineTotal),
    })),
    subtotal: money(data.subtotal),
    deliveryFee: money(data.deliveryFee),
    total: money(data.total),
    idempotencyKey: data.idempotencyKey,
    viewToken: data.viewToken,
    placedAt: data.placedAt,
    updatedAt: data.updatedAt,
  };
};

const toDocument = (order: Order): OrderDocument => ({
  _id: order.id,
  storeId: order.storeId,
  number: order.number,
  status: order.status,
  customer: { name: order.customer.name, phone: order.customer.phone },
  locale: order.locale,
  delivery: {
    region: order.delivery.region,
    city: order.delivery.city,
    street: order.delivery.street,
    notes: order.delivery.notes,
  },
  lines: order.lines.map((line) => ({
    sku: line.sku,
    title: line.title,
    options: line.options.map((option) => ({ name: option.name, value: option.value })),
    quantity: line.quantity,
    unitPrice: { cents: line.unitPrice.cents, currency: line.unitPrice.currency },
    lineTotal: { cents: line.lineTotal.cents, currency: line.lineTotal.currency },
  })),
  subtotal: { cents: order.subtotal.cents, currency: order.subtotal.currency },
  deliveryFee: { cents: order.deliveryFee.cents, currency: order.deliveryFee.currency },
  total: { cents: order.total.cents, currency: order.total.currency },
  idempotencyKey: order.idempotencyKey,
  viewToken: order.viewToken,
  placedAt: order.placedAt,
  updatedAt: order.updatedAt,
});

const DUPLICATE_KEY = 11000;

/** Which unique index refused the write, read from the field that actually collided. */
const asConflict = (error: unknown): OrderConflict | null => {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; keyValue?: Record<string, unknown> };
  if (candidate.code !== DUPLICATE_KEY) return null;

  const key = candidate.keyValue?.idempotencyKey;
  if (typeof key === 'string') return { tag: 'duplicate_checkout', idempotencyKey: key };

  const number = candidate.keyValue?.number;
  if (typeof number === 'string') return { tag: 'duplicate_number', number };

  return null;
};

export const createMongoOrderRepository = (db: Db): OrderRepository => {
  const collection: Collection<OrderDocument> = db.collection(ORDERS_COLLECTION);
  const counters: Collection<{ _id: string; seq: number }> = db.collection(COUNTERS_COLLECTION);

  return {
    async findById(storeId, id) {
      const document = await collection.findOne({ _id: id, storeId });
      return document === null ? null : toDomain(document);
    },

    async findByNumber(storeId, number) {
      const document = await collection.findOne({ storeId, number });
      return document === null ? null : toDomain(document);
    },

    async findByIdempotencyKey(storeId, key) {
      const document = await collection.findOne({ storeId, idempotencyKey: key });
      return document === null ? null : toDomain(document);
    },

    async list(query: ListOrdersQuery): Promise<OrderPage> {
      /*
       * Newest first, by _id — which is ULID-shaped, so it sorts
       * chronologically without a second field and without a second index. The
       * cursor is the last id seen, so a new order arriving between pages
       * cannot shift a row across the boundary the way an offset would.
       */
      const filter: Record<string, unknown> = { storeId: query.storeId };
      if (query.status !== undefined) filter.status = query.status;
      // Exact, on the stored E.164 shape. Every order goes in through the same
      // normaliser, so there is exactly one spelling to match.
      if (query.phone !== undefined) filter['customer.phone'] = query.phone;
      if (query.cursor !== undefined) filter._id = { $lt: query.cursor };

      const documents = await collection
        .find(filter)
        .sort({ _id: -1 })
        .limit(query.limit + 1)
        .toArray();

      const page = documents.slice(0, query.limit);
      return {
        orders: page.map(toDomain),
        nextCursor: documents.length > query.limit ? (page.at(-1)?._id ?? null) : null,
      };
    },

    async save(order): Promise<Result<void, OrderConflict>> {
      try {
        const document = toDocument(order);
        await collection.replaceOne({ _id: document._id, storeId: document.storeId }, document, {
          upsert: true,
        });
        return ok(undefined);
      } catch (error) {
        const conflict = asConflict(error);
        // Anything that is not a uniqueness conflict is a real fault — a dropped
        // connection must never be reported as "you already ordered that".
        if (conflict === null) throw error;
        return err(conflict);
      }
    },

    async updateStatus(storeId, id, from, to, now) {
      /*
       * The current status is part of the FILTER.
       *
       * Two operators with the same order open both read "pending"; only one
       * can match a filter that still demands it. Reading, deciding and then
       * writing would let both through — and for a cancellation, which gives
       * stock back, that means crediting the shelf twice.
       */
      const updated = await collection.findOneAndUpdate(
        { _id: id, storeId, status: from },
        { $set: { status: to, updatedAt: now } },
        { returnDocument: 'after' },
      );

      return updated === null ? null : toDomain(updated);
    },

    async nextSequence(storeId, year) {
      /*
       * One operation, not read-then-write.
       *
       * Two customers checking out in the same second must not be handed the
       * same number, and counting existing orders to work out the next one loses
       * that race by construction. The counter is per store and per year, so the
       * sequence resets in January without colliding with last year's numbers.
       */
      const result = await counters.findOneAndUpdate(
        { _id: `${storeId}:orders:${year}` },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      );

      if (result === null) throw new Error('Order counter did not return a value');
      return result.seq;
    },
  };
};

/** Called once at startup. Idempotent — createIndex is a no-op if it already exists. */
export const ensureOrderIndexes = async (db: Db): Promise<void> => {
  const collection = db.collection(ORDERS_COLLECTION);

  // The number is spoken on the phone and printed on a box: it identifies one
  // order, and two orders sharing one would be unresolvable at the door.
  await collection.createIndex(
    { storeId: 1, number: 1 },
    { unique: true, name: 'storeId_number_unique' },
  );

  /*
   * The index that makes a double-tapped checkout one order instead of two.
   *
   * It is the CONSTRAINT that does it, not a check in the application layer —
   * two requests can both find nothing and both proceed, but only one can write.
   */
  await collection.createIndex(
    { storeId: 1, idempotencyKey: 1 },
    { unique: true, name: 'storeId_idempotencyKey_unique' },
  );

  // The admin listing: newest first, optionally filtered by status.
  await collection.createIndex({ storeId: 1, status: 1, _id: -1 }, { name: 'storeId_status_id' });

  // The phone number IS the customer identity — "what did this number order?"
  // is the question the operator asks on every call.
  await collection.createIndex(
    { storeId: 1, 'customer.phone': 1, _id: -1 },
    { name: 'storeId_phone_id' },
  );
};
