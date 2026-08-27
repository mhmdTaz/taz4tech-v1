/**
 * Ports for orders. Infrastructure implements these; the application layer
 * depends only on them.
 */

import type { Result } from '@platform/result';
import type { Order, OrderId, OrderStatus } from '../domain/order';

/**
 * The database refused the write because an order like this already exists.
 *
 * `duplicate_checkout` is the useful one: the unique index on the idempotency
 * key is what turns a double-tapped submit into one order rather than two.
 */
export type OrderConflict =
  | { readonly tag: 'duplicate_checkout'; readonly idempotencyKey: string }
  | { readonly tag: 'duplicate_number'; readonly number: string };

export type ListOrdersQuery = {
  readonly storeId: string;
  readonly status?: OrderStatus;
  readonly limit: number;
  readonly cursor?: string;
};

export type OrderPage = {
  readonly orders: readonly Order[];
  readonly nextCursor: string | null;
};

export interface OrderRepository {
  findById(storeId: string, id: OrderId): Promise<Order | null>;
  /** By the number spoken on the phone. */
  findByNumber(storeId: string, number: string): Promise<Order | null>;
  /**
   * The order a given checkout produced, if it produced one.
   *
   * Read after a duplicate-key refusal so the customer sees the order they
   * already placed rather than an error about having placed it.
   */
  findByIdempotencyKey(storeId: string, key: string): Promise<Order | null>;
  list(query: ListOrdersQuery): Promise<OrderPage>;
  save(order: Order): Promise<Result<void, OrderConflict>>;
  /**
   * The next order number for a year, allocated atomically.
   *
   * A counter document incremented in one operation — two customers checking
   * out in the same second must not be handed the same number, and counting
   * existing orders to work out the next one loses that race by construction.
   */
  nextSequence(storeId: string, year: number): Promise<number>;
}

/**
 * Why stock could not be taken.
 *
 * The orders module's OWN vocabulary, not the inventory module's. That matters:
 * inventory answers "the adjustment failed, and here is why", while an order
 * needs to know the difference between "nobody counts this, sell it" and "there
 * are not that many". Translating at the composition root makes the mapping a
 * thing someone wrote down rather than two error unions that happen to overlap.
 */
export type StockTakeFailure =
  /** Nobody counts this SKU, so it sells freely. NOT a reason to refuse. */
  | { readonly tag: 'untracked' }
  /** Counted, and there are fewer than the order asks for. */
  | { readonly tag: 'insufficient'; readonly onHand: number };

/**
 * Moving stock for an order.
 *
 * Two named operations rather than one signed delta: `take(sku, 2)` and
 * `giveBack(sku, 2)` say what is happening, where `adjust(sku, -2)` and
 * `adjust(sku, 2)` differ by a minus sign that is very easy to get backwards in
 * a rollback.
 */
export interface StockLedger {
  take(sku: string, quantity: number): Promise<Result<void, StockTakeFailure>>;
  /** Best effort. Nothing useful can be done if putting stock back also fails. */
  giveBack(sku: string, quantity: number): Promise<void>;
}
