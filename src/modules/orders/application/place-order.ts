/**
 * Use case: turn a cart into an order.
 *
 * The most consequential thing this system does. It is where a customer's
 * intention becomes a commitment the shop has to honour, and where stock leaves
 * the shelf.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN
 * -------------------------------------
 *   1. validate the customer         — cheap, and rejects most bad input
 *   2. re-price the cart             — never from the browser, always live
 *   3. TAKE THE STOCK                — atomically, one line at a time
 *   4. allocate an order number      — only once the goods are secured
 *   5. write the order               — snapshotting everything above
 *
 * Stock is taken BEFORE the number is allocated so a failed checkout does not
 * burn a number, and before the write so an order never exists for goods the
 * shop does not have. If any later step fails, everything taken is given back.
 *
 * WHY COMPENSATION RATHER THAN A TRANSACTION
 * ------------------------------------------
 * Atlas would give us a multi-document transaction, and that would be tidier.
 * It is not used here because the test databases this runs against are
 * standalone servers, where transactions are unavailable — a correctness
 * mechanism that cannot be exercised in tests is a correctness mechanism nobody
 * should trust.
 *
 * So: take, and on failure give back. The residual risk is a process that dies
 * between taking and giving back, which leaves stock understated until someone
 * recounts a shelf. For a shop where the operator physically handles the goods
 * that is visible and recoverable — and it is written down here rather than
 * discovered later.
 */

import type { Cart, PriceCart } from '@modules/cart';
import type { EntityId } from '@platform/ids';
import { formatOrderNumber } from '@platform/ids';
import type { Locale } from '@platform/locale';
import { fromCents, type Money } from '@platform/money';
import { type PhoneError, parseLebanesePhone } from '@platform/phone';
import { isRegion, type Region } from '@platform/regions';
import { err, ok, type Result, unwrapOrThrow } from '@platform/result';
import type { OrderRepository, StockLedger } from '../contracts';
import { createOrder, type Order, type OrderError, type OrderLine } from '../domain/order';

export type PlaceOrderInput = {
  readonly cart: Cart;
  readonly locale: Locale;
  readonly name: string;
  /** As typed. Normalised here, so every caller gets the same rules. */
  readonly phone: string;
  readonly region: string;
  readonly city: string;
  readonly street: string;
  readonly notes: string;
  /** Generated when the checkout form was rendered. See the domain note. */
  readonly idempotencyKey: string;
};

export type PlaceOrderError =
  | { readonly tag: 'cart_empty' }
  | { readonly tag: 'phone_invalid'; readonly reason: PhoneError }
  | { readonly tag: 'region_invalid'; readonly region: string }
  /** Something in the cart cannot be supplied — the customer must adjust it. */
  | { readonly tag: 'cart_changed' }
  /** Someone took the last one between rendering the page and pressing the button. */
  | { readonly tag: 'out_of_stock'; readonly sku: string; readonly available: number }
  | { readonly tag: 'invalid'; readonly reason: OrderError };

export type PlaceOrder = (input: PlaceOrderInput) => Promise<Result<Order, PlaceOrderError>>;

export type PlaceOrderDeps = {
  readonly repository: OrderRepository;
  readonly priceCart: PriceCart;
  readonly stock: StockLedger;
  /**
   * What delivery costs to one governorate.
   *
   * Per region, because Beirut is not Akkar. The port takes the region rather
   * than returning a table so the orders module never has to know that a table
   * is how the shop happens to express it.
   */
  readonly deliveryFeeCents: (region: Region) => Promise<number>;
  readonly storeId: string;
  readonly now: () => Date;
  readonly nextId: () => EntityId<'Order'>;
  /**
   * Injected rather than called directly, like nextId, so a test can make the
   * confirmation URL predictable without reaching for a crypto mock.
   */
  readonly nextViewToken: () => string;
};

/** What was taken, so it can be given back. */
type Taken = { sku: string; quantity: number };

const giveBack = async (deps: PlaceOrderDeps, taken: readonly Taken[]): Promise<void> => {
  for (const line of taken) {
    // Best effort. If putting stock back also fails there is nothing further
    // this code can do about it, and throwing here would replace a recoverable
    // miscount with a 500 on a checkout already being refused for another
    // reason.
    await deps.stock.giveBack(line.sku, line.quantity).catch(() => undefined);
  }
};

export const makePlaceOrder =
  (deps: PlaceOrderDeps): PlaceOrder =>
  async (input) => {
    const phone = parseLebanesePhone(input.phone);
    if (!phone.ok) return err({ tag: 'phone_invalid', reason: phone.error });

    if (!isRegion(input.region)) return err({ tag: 'region_invalid', region: input.region });
    const region: Region = input.region;

    /*
     * Priced HERE, from the catalogue, moments before the order is written.
     *
     * The cart cookie carries SKUs and quantities and no money at all, so this
     * is the only place the amounts come from — and it is late enough that the
     * customer is charged what the shop is currently asking.
     */
    const priced = await deps.priceCart(input.cart, input.locale);
    if (priced.lines.length === 0) return err({ tag: 'cart_empty' });
    if (priced.hasProblems) return err({ tag: 'cart_changed' });

    const taken: Taken[] = [];

    for (const line of priced.lines) {
      const result = await deps.stock.take(line.sku, line.quantity);

      if (!result.ok) {
        /*
         * `untracked` is a SKU nobody counts, which sells freely — not a
         * failure, and nothing was taken, so there is nothing to give back for
         * this line either.
         */
        if (result.error.tag === 'untracked') continue;

        await giveBack(deps, taken);
        return err({ tag: 'out_of_stock', sku: line.sku, available: result.error.onHand });
      }

      taken.push({ sku: line.sku, quantity: line.quantity });
    }

    const now = deps.now();
    const sequence = await deps.repository.nextSequence(deps.storeId, now.getUTCFullYear());

    const built = await buildOrder({
      deps,
      input,
      priced,
      phone: phone.value,
      region,
      now,
      sequence,
    });

    if (!built.ok) {
      await giveBack(deps, taken);
      return built;
    }

    const saved = await deps.repository.save(built.value);
    if (saved.ok) return ok(built.value);

    /*
     * A duplicate checkout is a SUCCESS, not an error.
     *
     * The customer double-tapped on a slow connection. The unique index refused
     * the second write, which is exactly what it is for; the right answer is the
     * order they already placed. The stock this attempt took has to go back,
     * because the first attempt already took its own.
     */
    await giveBack(deps, taken);

    if (saved.error.tag === 'duplicate_checkout') {
      const existing = await deps.repository.findByIdempotencyKey(
        deps.storeId,
        input.idempotencyKey,
      );
      if (existing !== null) return ok(existing);
    }

    // A duplicated order NUMBER means the counter and the collection disagree,
    // which is not something to paper over with a retry.
    throw new Error(`Order write refused: ${saved.error.tag}`);
  };

const buildOrder = async (context: {
  deps: PlaceOrderDeps;
  input: PlaceOrderInput;
  priced: Awaited<ReturnType<PriceCart>>;
  phone: string;
  region: Region;
  now: Date;
  sequence: number;
}): Promise<Result<Order, PlaceOrderError>> => {
  const { deps, input, priced, phone, region, now, sequence } = context;

  const feeCents = await deps.deliveryFeeCents(region);
  /*
   * unwrapOrThrow, which is exactly what it is documented for: a boundary that
   * has already proven the value is fine. Every amount here is an integer sum of
   * integers that fromCents cannot reject — and writing the guard out longhand
   * would put a branch that can never be false in a layer gated at 100%.
   */
  const money = (cents: number): Money => unwrapOrThrow(fromCents(cents, priced.currency));

  const lines: OrderLine[] = priced.lines.map((line) => ({
    sku: line.sku,
    // Snapshotted, not referenced: this is what the customer agreed to buy,
    // whatever the product is renamed to afterwards.
    title: line.title,
    options: line.options.map((option) => ({ name: option.name, value: option.value })),
    quantity: line.quantity,
    unitPrice: money(line.unitPriceCents),
    lineTotal: money(line.lineTotalCents),
  }));

  const subtotal = money(priced.subtotalCents);
  const deliveryFee = money(feeCents);

  const order = createOrder({
    storeId: deps.storeId,
    id: deps.nextId(),
    number: formatOrderNumber(now.getUTCFullYear(), sequence),
    status: 'pending',
    customer: { name: input.name, phone },
    locale: input.locale,
    delivery: {
      region,
      city: input.city,
      street: input.street,
      notes: input.notes.trim().length === 0 ? null : input.notes,
    },
    lines,
    subtotal,
    deliveryFee,
    total: money(subtotal.cents + deliveryFee.cents),
    idempotencyKey: input.idempotencyKey.trim(),
    viewToken: deps.nextViewToken(),
    placedAt: now,
    updatedAt: now,
  });

  return order.ok ? ok(order.value) : err({ tag: 'invalid', reason: order.error });
};
