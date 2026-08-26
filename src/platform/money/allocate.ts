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
 * The remainder cents (0, 1 or 2 of them here) have to land *somewhere*, and
 * which line receives them is a policy decision, not a mathematical one.
 *
 * THE APPROACHES, AND WHAT EACH COSTS
 * -----------------------------------
 * 1. Largest remainder (Hamilton method)
 *    Give each line floor(share), then hand the leftover cents to the lines whose
 *    truncated fraction was largest. Most "fair" per line; the standard choice in
 *    accounting systems. Costs a sort, and ties need a deterministic tiebreak or
 *    the same cart allocates differently on two different runs.
 *
 * 2. First-line-absorbs
 *    Everyone gets floor(share); line 0 takes the entire remainder. Trivial,
 *    perfectly deterministic, and easy to explain to a customer on the phone.
 *    Slightly "unfair" to whichever item happens to sort first.
 *
 * 3. Running-total / sequential
 *    Track the cumulative exact value and diff against the cumulative allocated
 *    value, so each line self-corrects. Naturally exact with no sort, and it is
 *    what most tax engines do. Distributes the drift, but the per-line number
 *    depends on ordering, which makes it harder to eyeball on an invoice.
 *
 * CONSTRAINTS THAT APPLY HERE
 * ---------------------------
 * - Must be deterministic: the same cart must allocate identically on the
 *   storefront preview, at checkout, on the invoice, and on a partial return.
 * - Weights are line subtotals in cents (non-negative integers, at least one > 0).
 * - Must survive a negative total (a discount is allocated as a negative amount).
 * - Must handle a zero-weight line (a free gift) without giving it a stray cent.
 */

import type { Money } from './types';

/**
 * Split `total` across `weights`, proportionally, losing nothing.
 *
 * @param total   the amount to distribute (may be negative, e.g. a discount)
 * @param weights per-line weights in cents; length matches the returned array
 * @returns       one integer cent amount per weight, summing exactly to total.cents
 *
 * TODO(mohammad): implement the allocation policy.
 *
 * Sketch of the shape it needs to take:
 *
 *   const totalWeight = weights.reduce((a, b) => a + b, 0);
 *   if (totalWeight === 0) return weights.map(() => 0);   // nothing to weigh against
 *   // 1. give every line its floor/truncated share
 *   // 2. compute the leftover: total.cents - sum(shares)
 *   // 3. distribute those leftover cents by whichever policy you choose
 *   // 4. return shares
 *
 * The tests in allocate.test.ts already pin the invariants (sums are exact,
 * zero-weight lines get zero, negatives work, results are stable across runs) —
 * they will pass for any of the three policies above, so pick on the accounting
 * merits and the tests will tell you if the edges are wrong.
 */
// The parameters are unused only because the body is unwritten; the signature is
// the contract this function has to satisfy once the policy is chosen.
// biome-ignore lint/correctness/noUnusedFunctionParameters: implementation pending
export const allocate = (total: Money, weights: readonly number[]): number[] => {
  throw new Error('allocate() is not implemented yet — see the TODO in this file.');
};
