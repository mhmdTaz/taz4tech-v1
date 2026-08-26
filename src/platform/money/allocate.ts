/**
 * Splitting one amount across several line items without losing or inventing a cent.
 *
 * WHY THIS EXISTS
 * ---------------
 * A cart-level discount is applied to the order, but the invoice, the return,
 * and the driver's cash sheet all need it *per line*. Three items at $10.00 each
 * with a $10.00 cart discount is $3.3333... per line. Round each independently
 * and you bill $9.99 or $10.01 — the invoice no longer foots, and under Law
 * 81/2018 the order acknowledgement you sent shows a different number than the
 * amount the driver collects at the door.
 *
 * So the invariant is absolute:
 *
 *     sum(allocate(total, weights)) === total.cents      ALWAYS
 *
 * THE POLICY: LARGEST REMAINDER (HAMILTON), TIES BY LINE ORDER
 * ------------------------------------------------------------
 * Every line gets its share truncated toward zero; the leftover cents go to the
 * lines whose truncated fraction was largest, and a tie is broken by original
 * index.
 *
 * Chosen over the alternatives because it bounds the error: no line ends up more
 * than one cent from its exact proportional share. "First line absorbs the
 * remainder" is simpler but can pile three cents onto line 1 of a four-line
 * order, and does so systematically — always the same line. A running-total
 * approach is also exact, but its per-line figures are harder to reconcile by
 * hand. Largest remainder is the standard apportionment in accounting systems,
 * so these numbers match what an accountant expects to see.
 *
 * Determinism does not rely on Array.sort being stable: the comparator falls
 * back to the original index explicitly, so the same cart allocates identically
 * on the storefront preview, at checkout, on the invoice, and on a return.
 *
 * ALLOCATE ONCE, THEN PERSIST
 * ---------------------------
 * Callers must store the result on the order and never recompute it. Re-running
 * this over a subset of lines during a partial return yields different per-line
 * figures than the invoice already sent to the customer — a discrepancy in a
 * document Art. 35 requires to be accurate, not a rounding curiosity.
 *
 * PRECONDITIONS
 * -------------
 * - `weights` are non-negative integers (line subtotals in cents).
 * - Arithmetic is exact while |total.cents| * max(weight) stays under 2^53,
 *   which is around a hundred-billion-cent cart. Not a real constraint here.
 */

import type { Money } from './types';

/**
 * Split `total` across `weights`, proportionally, losing nothing.
 *
 * @param total   the amount to distribute (may be negative, e.g. a discount)
 * @param weights per-line weights in cents; length matches the returned array
 * @returns       one integer cent amount per weight, summing exactly to total.cents
 */
export const allocate = (total: Money, weights: readonly number[]): number[] => {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  // Nothing to weigh against. Returning zeros rather than spreading the amount
  // evenly is deliberate: a cart whose lines are all free has no basis on which
  // to apportion a discount, and inventing one would silently bill somebody.
  if (totalWeight === 0) return weights.map(() => 0);

  const amount = total.cents;

  /*
   * Integer arithmetic throughout. `product / totalWeight` as a float would
   * round 3 to 2.9999999999999996 at some inputs and truncate to 2, losing a
   * cent in the one function whose entire purpose is not to.
   *
   * `%` is exact on integers within the safe range and truncates toward zero,
   * so `remainder` carries the sign of `product` and `product - remainder` is
   * exactly divisible.
   */
  const lines = weights.map((weight, index) => {
    const product = amount * weight;
    const fraction = product % totalWeight;
    return {
      index,
      share: (product - fraction) / totalWeight,
      // Magnitude of the discarded fraction: how much this line was short-changed.
      fraction: Math.abs(fraction),
    };
  });

  const allocated = lines.reduce((sum, line) => sum + line.share, 0);
  const leftover = amount - allocated;

  /*
   * Hand out the leftover cents, one per line, to the largest discarded
   * fractions first. Each carries the sign of the total, so a negative amount
   * (a discount) distributes negative cents.
   *
   * A zero-weight line can never receive one. If `leftover` is k cents then the
   * discarded fractions sum to k * totalWeight, and since each is strictly less
   * than totalWeight there must be at least k + 1 lines with a non-zero
   * fraction — so the top k by magnitude all have one, and a zero-weight line
   * (fraction 0) is never among them. A free gift absorbs no discount.
   */
  const step = leftover < 0 ? -1 : 1;

  const receivesExtraCent = new Set(
    [...lines]
      .sort((a, b) => (a.fraction === b.fraction ? a.index - b.index : b.fraction - a.fraction))
      .slice(0, Math.abs(leftover))
      .map((line) => line.index),
  );

  // Expressed as a set membership rather than an indexed write on purpose:
  // mutating result[order[i].index] needs two guards that noUncheckedIndexedAccess
  // demands but that can never fire, leaving untestable branches in the one
  // function where an untested branch is least acceptable.
  return lines.map((line) => line.share + (receivesExtraCent.has(line.index) ? step : 0));
};
