import { describe, expect, it } from 'vitest';
import { unwrapOrThrow } from '../result';
import { allocate } from './allocate';
import { fromCents } from './index';

const usd = (cents: number) => unwrapOrThrow(fromCents(cents));
const total = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** Deterministic PRNG so a failure is always reproducible from the seed. */
const lcg = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

describe('allocate', () => {
  it('never loses or invents a cent, even when the split is not exact', () => {
    const result = allocate(usd(1000), [1000, 1000, 1000]);
    expect(total(result)).toBe(1000);
    expect(result).toHaveLength(3);
  });

  it('returns whole cents only', () => {
    const result = allocate(usd(1000), [1000, 1000, 1000]);
    for (const cents of result) expect(Number.isInteger(cents)).toBe(true);
  });

  it('gives a single line the entire amount', () => {
    expect(allocate(usd(1299), [4999])).toEqual([1299]);
  });

  it('splits an exactly-divisible amount evenly', () => {
    expect(allocate(usd(900), [100, 100, 100])).toEqual([300, 300, 300]);
  });

  it('gives a zero-weight line nothing (a free gift absorbs no discount)', () => {
    const result = allocate(usd(1000), [500, 0, 500]);
    expect(result[1]).toBe(0);
    expect(total(result)).toBe(1000);
  });

  it('allocates nothing when every weight is zero', () => {
    expect(allocate(usd(1000), [0, 0])).toEqual([0, 0]);
  });

  it('handles a negative total (a discount distributed across lines)', () => {
    const result = allocate(usd(-1000), [1000, 1000, 1000]);
    expect(total(result)).toBe(-1000);
    for (const cents of result) expect(cents).toBeLessThanOrEqual(0);
  });

  it('allocates proportionally, not equally', () => {
    const result = allocate(usd(1000), [750, 250]);
    expect(result).toEqual([750, 250]);
  });

  it('gives the leftover cent to the most short-changed line, not to the first', () => {
    // Exact shares are 5.00, 3.33, 1.67. Line 2 lost the most to truncation, so
    // it receives the leftover cent. A first-line-absorbs policy would return
    // [6, 3, 1] here — this assertion is what pins the policy down.
    expect(allocate(usd(10), [3, 2, 1])).toEqual([5, 3, 2]);
  });

  it('breaks a tie by line order, so equal fractions are not order-dependent', () => {
    // Exact shares are 3.33 each: all three lost the same to truncation, so the
    // single leftover cent goes to the earliest line rather than an arbitrary one.
    expect(allocate(usd(1000), [1000, 1000, 1000])).toEqual([334, 333, 333]);
  });

  it('spreads several leftover cents across distinct lines, one each', () => {
    // 6 lines, exact share 1.67 apiece: four leftover cents, four different lines.
    expect(allocate(usd(10), [1, 1, 1, 1, 1, 1])).toEqual([2, 2, 2, 2, 1, 1]);
  });

  it('never puts a line more than one cent off its exact share', () => {
    // This is the property that justified largest-remainder over the simpler
    // policies, so it is asserted rather than assumed.
    const rand = lcg(4242);
    for (let i = 0; i < 1000; i++) {
      const weights = Array.from({ length: 2 + Math.floor(rand() * 6) }, () =>
        Math.floor(rand() * 9_000),
      );
      const totalWeight = total(weights);
      if (totalWeight === 0) continue;

      const amount = Math.floor(rand() * 100_000) - 50_000;
      const result = allocate(usd(amount), weights);

      result.forEach((cents, line) => {
        const exact = (amount * (weights[line] ?? 0)) / totalWeight;
        expect(Math.abs(cents - exact)).toBeLessThan(1);
      });
    }
  });

  it('is deterministic — the same cart allocates identically every time', () => {
    const once = allocate(usd(1000), [333, 333, 334]);
    const twice = allocate(usd(1000), [333, 333, 334]);
    expect(once).toEqual(twice);
  });

  it('holds the sum invariant across 2000 randomised carts', () => {
    const rand = lcg(20260826);
    for (let i = 0; i < 2000; i++) {
      const lines = 1 + Math.floor(rand() * 8);
      const weights = Array.from({ length: lines }, () => Math.floor(rand() * 50_000));
      const amount = Math.floor(rand() * 200_000) - 100_000;
      const result = allocate(usd(amount), weights);

      expect(result).toHaveLength(lines);
      if (total(weights) === 0) {
        expect(total(result)).toBe(0);
      } else {
        expect(total(result)).toBe(amount);
      }
    }
  });

  it('never gives a cent to a zero-weight line, across randomised carts', () => {
    const rand = lcg(99);
    for (let i = 0; i < 500; i++) {
      const weights = [Math.floor(rand() * 1000), 0, Math.floor(rand() * 1000), 0];
      if (total(weights) === 0) continue;
      const result = allocate(usd(Math.floor(rand() * 10_000)), weights);
      expect(result[1]).toBe(0);
      expect(result[3]).toBe(0);
    }
  });
});
