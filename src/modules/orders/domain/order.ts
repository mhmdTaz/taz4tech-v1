/**
 * An order.
 *
 * IT IS A SNAPSHOT, NOT A SET OF REFERENCES
 * -----------------------------------------
 * Every line carries the title, the options and the PRICE as they were at the
 * moment the customer agreed to them. Nothing here is looked up again later.
 *
 * That is the whole point of an order. Change a price tomorrow and yesterday's
 * order must still say what was agreed; archive a product and last month's
 * order must still be readable. An order that re-read the catalogue would be a
 * record that quietly rewrites itself — which for a cash-on-delivery business is
 * the difference between a receipt and a guess, at the door, with the customer
 * holding the money.
 *
 * THE PHONE NUMBER IS THE IDENTITY
 * --------------------------------
 * There are no accounts. An order is found by phone, arranged by phone and
 * delivered by someone who calls first, so the number is stored in exactly one
 * shape and validated on the way in.
 */

import type { Money } from '@platform/money';
import { compare, fromCents, isNegative } from '@platform/money';
import { isE164 } from '@platform/phone';

export type OrderId = string;

/**
 * Lebanon's eight governorates.
 *
 * A closed list rather than a free-text field: delivery is arranged per region,
 * and "Mount Lebanon" typed four different ways is four regions to anyone
 * counting. The customer's exact address goes in the lines below it.
 */
export const REGIONS = [
  'beirut',
  'mount_lebanon',
  'north',
  'akkar',
  'bekaa',
  'baalbek_hermel',
  'south',
  'nabatieh',
] as const;

export type Region = (typeof REGIONS)[number];

export const isRegion = (value: string): value is Region =>
  (REGIONS as readonly string[]).includes(value);

/**
 * The lifecycle.
 *
 * `pending` is where every order starts: placed by the customer, not yet
 * confirmed by the operator, who calls before anything ships. `confirmed` means
 * that call happened. Cash changes hands at `delivered`.
 */
export const ORDER_STATUSES = ['pending', 'confirmed', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses from which stock has been taken and would have to be given back. */
export const HOLDS_STOCK: readonly OrderStatus[] = ['pending', 'confirmed', 'delivered'];

export type Customer = {
  readonly name: string;
  /** E.164. The identity anchor for the whole system. */
  readonly phone: string;
};

export type DeliveryAddress = {
  readonly region: Region;
  /** Town or city within the region. */
  readonly city: string;
  /** Street, building, floor — whatever gets a driver to the door. */
  readonly street: string;
  /** "Ring the bell twice", "call when you arrive". Optional and often the useful part. */
  readonly notes: string | null;
};

export type OrderLine = {
  readonly sku: string;
  /** As it was called when it was ordered. */
  readonly title: string;
  readonly options: readonly { readonly name: string; readonly value: string }[];
  readonly quantity: number;
  /** The price agreed, per unit. Never re-read. */
  readonly unitPrice: Money;
  readonly lineTotal: Money;
};

export type Order = {
  readonly storeId: string;
  readonly id: OrderId;
  /** Human, spoken aloud on the phone: T4T-26-000042. */
  readonly number: string;
  readonly status: OrderStatus;
  readonly customer: Customer;
  readonly delivery: DeliveryAddress;
  readonly lines: readonly OrderLine[];
  readonly subtotal: Money;
  readonly deliveryFee: Money;
  readonly total: Money;
  /**
   * What the customer's browser called this checkout.
   *
   * A unique index on it is what makes a double-tapped submit one order rather
   * than two — the second write is refused by the database, not by a check that
   * could be raced.
   */
  readonly idempotencyKey: string;
  readonly placedAt: Date;
  readonly updatedAt: Date;
};

export type OrderError =
  | { readonly tag: 'no_lines' }
  | { readonly tag: 'too_many_lines'; readonly max: number }
  | { readonly tag: 'customer_name_empty' }
  | { readonly tag: 'customer_name_too_long'; readonly max: number }
  | { readonly tag: 'phone_not_e164'; readonly phone: string }
  | { readonly tag: 'city_empty' }
  | { readonly tag: 'street_empty' }
  | { readonly tag: 'field_too_long'; readonly field: string; readonly max: number }
  | { readonly tag: 'quantity_invalid'; readonly sku: string; readonly quantity: number }
  | { readonly tag: 'price_negative'; readonly sku: string }
  | { readonly tag: 'line_total_wrong'; readonly sku: string }
  | { readonly tag: 'delivery_fee_negative' }
  | { readonly tag: 'total_wrong' }
  | { readonly tag: 'idempotency_key_empty' };

export const MAX_LINES = 30;
export const MAX_NAME = 120;
export const MAX_CITY = 80;
export const MAX_STREET = 240;
export const MAX_NOTES = 500;

type OrderResult = { ok: true; value: Order } | { ok: false; error: OrderError };

const blank = (value: string): boolean => value.trim().length === 0;

const validateCustomer = (customer: Customer): OrderError | null => {
  if (blank(customer.name)) return { tag: 'customer_name_empty' };
  if (customer.name.trim().length > MAX_NAME) {
    return { tag: 'customer_name_too_long', max: MAX_NAME };
  }
  // Already normalised by the time it gets here; this catches a caller that
  // skipped the parser rather than a customer who typed it oddly.
  if (!isE164(customer.phone)) return { tag: 'phone_not_e164', phone: customer.phone };
  return null;
};

const validateDelivery = (delivery: DeliveryAddress): OrderError | null => {
  if (blank(delivery.city)) return { tag: 'city_empty' };
  if (delivery.city.trim().length > MAX_CITY) {
    return { tag: 'field_too_long', field: 'city', max: MAX_CITY };
  }
  if (blank(delivery.street)) return { tag: 'street_empty' };
  if (delivery.street.trim().length > MAX_STREET) {
    return { tag: 'field_too_long', field: 'street', max: MAX_STREET };
  }
  if (delivery.notes !== null && delivery.notes.trim().length > MAX_NOTES) {
    return { tag: 'field_too_long', field: 'notes', max: MAX_NOTES };
  }
  return null;
};

const validateLine = (line: OrderLine): OrderError | null => {
  if (!Number.isInteger(line.quantity) || line.quantity < 1) {
    return { tag: 'quantity_invalid', sku: line.sku, quantity: line.quantity };
  }
  if (isNegative(line.unitPrice)) return { tag: 'price_negative', sku: line.sku };

  /*
   * The arithmetic is CHECKED, not trusted.
   *
   * A line total that does not equal price x quantity is the one error in an
   * order that nobody notices until the cash is counted — and by then the
   * customer is at the door holding a different number.
   */
  const expected = fromCents(line.unitPrice.cents * line.quantity, line.unitPrice.currency);
  if (!expected.ok || compare(expected.value, line.lineTotal) !== 0) {
    return { tag: 'line_total_wrong', sku: line.sku };
  }
  return null;
};

/**
 * Build an order, or say exactly why not.
 *
 * The only way to obtain an Order — so no caller can construct one whose totals
 * do not add up, and every field a driver or an invoice depends on is present.
 */
export const createOrder = (input: Order): OrderResult => {
  if (input.lines.length === 0) return { ok: false, error: { tag: 'no_lines' } };
  if (input.lines.length > MAX_LINES) {
    return { ok: false, error: { tag: 'too_many_lines', max: MAX_LINES } };
  }
  if (blank(input.idempotencyKey)) return { ok: false, error: { tag: 'idempotency_key_empty' } };

  const customerProblem = validateCustomer(input.customer);
  if (customerProblem !== null) return { ok: false, error: customerProblem };

  const deliveryProblem = validateDelivery(input.delivery);
  if (deliveryProblem !== null) return { ok: false, error: deliveryProblem };

  for (const line of input.lines) {
    const lineProblem = validateLine(line);
    if (lineProblem !== null) return { ok: false, error: lineProblem };
  }

  if (isNegative(input.deliveryFee)) return { ok: false, error: { tag: 'delivery_fee_negative' } };

  const subtotalCents = input.lines.reduce((total, line) => total + line.lineTotal.cents, 0);
  const expectedTotal = subtotalCents + input.deliveryFee.cents;

  if (input.subtotal.cents !== subtotalCents || input.total.cents !== expectedTotal) {
    return { ok: false, error: { tag: 'total_wrong' } };
  }

  return {
    ok: true,
    value: {
      ...input,
      customer: {
        name: input.customer.name.trim(),
        phone: input.customer.phone,
      },
      delivery: {
        region: input.delivery.region,
        city: input.delivery.city.trim(),
        street: input.delivery.street.trim(),
        // A whitespace note reads as present to anything that only checks for
        // null, and prints as an empty line on a picking slip.
        notes:
          input.delivery.notes === null || blank(input.delivery.notes)
            ? null
            : input.delivery.notes.trim(),
      },
    },
  };
};

/** Whether this order still has stock allocated to it. */
export const holdsStock = (order: Order): boolean => HOLDS_STOCK.includes(order.status);

/**
 * Which transitions are allowed.
 *
 * Cancelling gives stock back, so it must not be reachable from a state that
 * already gave it back — cancelling twice would credit the shelf twice.
 */
const NEXT: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  NEXT[from].includes(to);

export const totalItems = (order: Order): number =>
  order.lines.reduce((total, line) => total + line.quantity, 0);
