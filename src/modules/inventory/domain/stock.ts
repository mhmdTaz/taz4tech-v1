/**
 * Stock levels.
 *
 * WHY THIS IS A SEPARATE DOCUMENT, AND A SEPARATE MODULE
 * -----------------------------------------------------
 * Variants live inside the product; their stock does not. Two reasons, and both
 * bite in production rather than in a diagram:
 *
 *   1. Stock changes far more often than anything else about a product. Storing
 *      it inside the product means every sale rewrites the whole document — and
 *      with it the derived searchText field and every index entry that depends
 *      on it. A shop that sells well would spend its write budget re-indexing
 *      descriptions that did not change.
 *   2. Selling the last unit twice is a database problem, not an application
 *      one. It is prevented by a conditional update on one small document
 *      (`decrement where onHand >= quantity`), which is only available if that
 *      document is the unit of contention. Read-modify-write on a product
 *      aggregate loses that race by construction.
 *
 * ABSENCE MEANS UNTRACKED, NOT ZERO
 * ---------------------------------
 * A SKU with no record is not out of stock — it is a SKU nobody has chosen to
 * count. That is the right default for a shop where most things are simply on
 * the shelf and a few are worth counting: importing a catalogue does not make
 * every product unbuyable, and tracking is opted into per SKU.
 *
 * The cost is that a mistyped SKU silently reads as untracked rather than
 * failing loudly. The admin surfaces which SKUs have no record, which is the
 * place that mismatch is actually visible.
 */

export type StockPolicy =
  /** Counted. Sales decrement it and it can run out. */
  | 'tracked'
  /** Deliberately not counted — made to order, or always in the van. */
  | 'untracked';

export type StockLevel = {
  readonly storeId: string;
  /** A SKU identifies exactly one variant across the whole store. */
  readonly sku: string;
  readonly policy: StockPolicy;
  /** Whole units. Meaningless when the policy is untracked, and kept at 0 there. */
  readonly onHand: number;
  readonly updatedAt: Date;
};

export type StockError =
  | { readonly tag: 'sku_empty' }
  | { readonly tag: 'quantity_not_a_whole_number'; readonly onHand: number }
  | { readonly tag: 'quantity_negative'; readonly onHand: number }
  | { readonly tag: 'quantity_absurd'; readonly onHand: number };

/**
 * A ceiling, so a mistyped quantity is a refusal rather than a stock take.
 *
 * Nobody holding a million units of one SKU is running this shop, and an
 * accidental extra zero is a very ordinary spreadsheet accident.
 */
export const MAX_ON_HAND = 1_000_000;

export const createStockLevel = (
  input: StockLevel,
): { ok: true; value: StockLevel } | { ok: false; error: StockError } => {
  const sku = input.sku.trim();
  if (sku.length === 0) return { ok: false, error: { tag: 'sku_empty' } };

  if (!Number.isInteger(input.onHand)) {
    return { ok: false, error: { tag: 'quantity_not_a_whole_number', onHand: input.onHand } };
  }
  if (input.onHand < 0) {
    return { ok: false, error: { tag: 'quantity_negative', onHand: input.onHand } };
  }
  if (input.onHand > MAX_ON_HAND) {
    return { ok: false, error: { tag: 'quantity_absurd', onHand: input.onHand } };
  }

  return {
    ok: true,
    // An untracked SKU carries no count. Keeping a stale number on it would
    // read as stock to anything that looked at onHand without checking policy
    // first — and something eventually will.
    value: { ...input, sku, onHand: input.policy === 'untracked' ? 0 : input.onHand },
  };
};

export type Availability =
  /** Countable units remain, or the SKU is not counted at all. */
  'in_stock' | 'out_of_stock';

/**
 * Whether this SKU can be sold right now.
 *
 * `null` — no record — is IN STOCK, not out of it. See the note at the top: a
 * SKU nobody counts is not a SKU that ran out.
 */
export const availabilityOf = (level: StockLevel | null): Availability => {
  if (level === null) return 'in_stock';
  if (level.policy === 'untracked') return 'in_stock';
  return level.onHand > 0 ? 'in_stock' : 'out_of_stock';
};

/**
 * Whether a quantity can be taken from this SKU.
 *
 * Separate from availabilityOf because "is this on sale" and "can I have nine"
 * are different questions, and a basket asks the second.
 */
export const canTake = (level: StockLevel | null, quantity: number): boolean => {
  if (!Number.isInteger(quantity) || quantity < 1) return false;
  if (level === null || level.policy === 'untracked') return true;
  return level.onHand >= quantity;
};

/**
 * The count to SHOW, or null when there is nothing honest to say.
 *
 * An untracked SKU has no number: printing "In stock (0)" for something the shop
 * simply has is worse than printing nothing, and printing a made-up number is
 * worse again.
 */
export const countToShow = (level: StockLevel | null): number | null =>
  level === null || level.policy === 'untracked' ? null : level.onHand;
