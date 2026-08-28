/**
 * Use case: move an order through its lifecycle.
 *
 * pending -> confirmed -> delivered, with cancelled reachable from either of the
 * first two. Delivered and cancelled are terminal.
 *
 * CANCELLING GIVES STOCK BACK, WHICH IS WHY THE ORDER OF OPERATIONS MATTERS
 * ------------------------------------------------------------------------
 * The status is flipped FIRST, with a conditional write that demands the order
 * is still in the status the operator was looking at. Only then is stock
 * returned.
 *
 * That order is deliberate. Two operators cancelling the same order both read
 * "pending"; only one can match a filter that still demands it, so only one
 * returns the stock. Returning stock first and flipping second would let both
 * credit the shelf and one then find the order already cancelled — a shelf that
 * has gained a unit nobody sold.
 *
 * The residual risk is the same one placeOrder carries: a process that dies
 * between the flip and the credit leaves stock understated. Visible when the
 * shelf is next counted, and the opposite mistake — stock overstated, a second
 * customer promised something that is not there — is the expensive one.
 */

import { parseLebanesePhone } from '@platform/phone';
import { err, ok, type Result } from '@platform/result';
import type { OrderRepository, StockLedger } from '../contracts';
import {
  canTransition,
  holdsStock,
  type Order,
  type OrderId,
  type OrderStatus,
} from '../domain/order';

export type UpdateOrderStatusError =
  | { readonly tag: 'not_found' }
  /** The transition is not one the lifecycle allows, e.g. delivered -> pending. */
  | { readonly tag: 'not_allowed'; readonly from: OrderStatus; readonly to: OrderStatus }
  /**
   * Somebody else moved it first.
   *
   * Distinct from `not_allowed`: the transition was legal when the operator
   * looked at the screen, and is not any more. The right answer is to show them
   * the order as it now is, not to tell them they did something wrong.
   */
  | { readonly tag: 'already_moved'; readonly current: OrderStatus };

/**
 * `from` is the status the operator's SCREEN was rendered from.
 *
 * Not a status read here and compared against itself — that would only notice a
 * change during this request. Carrying it in means an order that moved while the
 * screen sat open is reported as a race rather than as an illegal transition,
 * which is the difference between "somebody beat you to it" and "you did
 * something wrong".
 *
 * It is not a trusted value: a forged `from` matches no document, and the write
 * filters on it.
 */
export type UpdateOrderStatus = (
  id: OrderId,
  from: OrderStatus,
  to: OrderStatus,
) => Promise<Result<Order, UpdateOrderStatusError>>;

export const makeUpdateOrderStatus =
  (deps: {
    repository: OrderRepository;
    stock: StockLedger;
    storeId: string;
    now: () => Date;
  }): UpdateOrderStatus =>
  async (id, from, to) => {
    const order = await deps.repository.findById(deps.storeId, id);
    if (order === null) return err({ tag: 'not_found' });

    // The screen is stale. Checked before the lifecycle, because "pending ->
    // confirmed on an order that is already confirmed" is a race, and answering
    // it with "that transition is not allowed" would blame the wrong person.
    if (order.status !== from) return err({ tag: 'already_moved', current: order.status });

    if (!canTransition(from, to)) return err({ tag: 'not_allowed', from, to });

    // Whether stock is coming back is decided BEFORE the write, from the status
    // the order actually had — after the flip it says `cancelled`, which holds
    // no stock, and the answer would always be no.
    const returningStock = to === 'cancelled' && holdsStock(order);

    const updated = await deps.repository.updateStatus(deps.storeId, id, from, to, deps.now());
    if (updated === null) {
      // The filter demanded the old status and did not match, so somebody moved
      // it between the read above and this write. Re-read to say what it is now.
      const current = await deps.repository.findById(deps.storeId, id);

      // Gone entirely. Reporting the status it used to have would be inventing
      // a fact about a record that no longer exists.
      if (current === null) return err({ tag: 'not_found' });

      return err({ tag: 'already_moved', current: current.status });
    }

    if (returningStock) {
      for (const line of updated.lines) {
        // Best effort, and only ever reached by the one caller whose conditional
        // write won. An untracked SKU has nothing to credit, which the ledger
        // handles rather than this loop.
        await deps.stock.giveBack(line.sku, line.quantity).catch(() => undefined);
      }
    }

    return ok(updated);
  };

/**
 * What the list was asked to find, and whether it could.
 *
 * `unreadable` is its own case rather than an empty result, because "no orders
 * for +961 3 123 456" and "that is not a phone number" are different sentences
 * and the operator is on the phone to somebody while they read one of them.
 */
export type PhoneSearch =
  | { readonly tag: 'none' }
  | { readonly tag: 'searched'; readonly e164: string }
  | { readonly tag: 'unreadable'; readonly input: string };

export type ListOrders = (input: {
  readonly status?: OrderStatus;
  readonly limit?: number;
  readonly cursor?: string;
  /** As the operator typed it. Normalised here, so "03 123 456" finds the order. */
  readonly phone?: string;
}) => Promise<{
  readonly orders: readonly Order[];
  readonly nextCursor: string | null;
  readonly phone: PhoneSearch;
}>;

/** How many orders one admin page shows. */
export const DEFAULT_ORDER_PAGE = 25;
export const MAX_ORDER_PAGE = 100;

export const makeListOrders =
  (deps: { repository: OrderRepository; storeId: string }): ListOrders =>
  async (input) => {
    const requested = input.limit ?? DEFAULT_ORDER_PAGE;
    // Clamped rather than refused: this is an internal screen, and an operator
    // fiddling with a query string wants a page, not an error.
    const limit = Math.min(
      Math.max(Math.trunc(requested) || DEFAULT_ORDER_PAGE, 1),
      MAX_ORDER_PAGE,
    );

    /*
     * The operator types what a customer says: "03 123 456". Orders store one
     * shape, +9613123456, because every one of them went in through the same
     * normaliser — so the search has to go through it too, or the number on the
     * screen never matches the number in the database.
     */
    const phone = phoneSearch(input.phone);

    if (phone.tag === 'unreadable') {
      // Nothing is asked of the database: an unreadable number cannot match a
      // stored one, and a query that scans for it is a query for nothing.
      return { orders: [], nextCursor: null, phone };
    }

    const page = await deps.repository.list({
      storeId: deps.storeId,
      limit,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.cursor === undefined || input.cursor.length === 0 ? {} : { cursor: input.cursor }),
      ...(phone.tag === 'searched' ? { phone: phone.e164 } : {}),
    });

    return { ...page, phone };
  };

const phoneSearch = (input: string | undefined): PhoneSearch => {
  const typed = (input ?? '').trim();
  if (typed.length === 0) return { tag: 'none' };

  const parsed = parseLebanesePhone(typed);
  return parsed.ok ? { tag: 'searched', e164: parsed.value } : { tag: 'unreadable', input: typed };
};
