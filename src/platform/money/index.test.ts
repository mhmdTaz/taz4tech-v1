import { describe, expect, it } from 'vitest';
import { unwrapOrThrow } from '../result';
import {
  add,
  applyRate,
  compare,
  equals,
  format,
  fromCents,
  isNegative,
  isZero,
  negate,
  parse,
  roundHalfUp,
  scaleByBasisPoints,
  subtract,
  sum,
  times,
  toDecimalString,
  zero,
} from './index';

const usd = (cents: number) => unwrapOrThrow(fromCents(cents));
const notUsd = { cents: 100, currency: 'EUR' as unknown as 'USD' };

describe('Money construction', () => {
  it('accepts whole cents', () => {
    expect(fromCents(1299)).toEqual({ ok: true, value: { cents: 1299, currency: 'USD' } });
  });

  it('rejects a fractional cent rather than rounding silently', () => {
    const r = fromCents(10.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.tag).toBe('not_an_integer');
  });

  it('rejects NaN and Infinity', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = fromCents(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.tag).toBe('not_finite');
    }
  });

  it('zero() is zero USD', () => {
    expect(zero()).toEqual({ cents: 0, currency: 'USD' });
    expect(isZero(zero())).toBe(true);
  });
});

describe('Money.parse', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['12.50', 1250],
    ['0.09', 9],
    ['$1,299.99', 129999],
    ['-4.20', -420],
    ['  7.07  ', 707],
  ])('parses %s as %d cents', (input, cents) => {
    const r = parse(input as string);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.cents).toBe(cents);
  });

  it('reads fractional digits as characters, not through a float', () => {
    // parseFloat('1.115') * 100 is 111.49999999999999, which truncates to 111c.
    // Three decimal places are not a valid cent amount, so this is rejected
    // outright rather than silently losing a cent.
    expect(parse('1.115').ok).toBe(false);
  });

  it.each(['', 'abc', '1.234', '1.2.3', '--1', '.5', '5.'])('rejects %s', (input) => {
    const r = parse(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.tag).toBe('unparsable');
  });

  it.each(['12,34', '1,23', '1,2345', '1,23,456', '12,3'])(
    'rejects %s, where the comma cannot be a thousands separator',
    (input) => {
      // A thousands separator is always followed by exactly three digits, so
      // "12,34" is a European decimal comma meaning 12.34. Reading it as 1234
      // makes the amount a hundred times too large — a supplier price list from
      // France would import every price 100x over. There is no safe guess.
      const r = parse(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.tag).toBe('unparsable');
    },
  );

  it.each(['1,299', '1,299.99', '12,345,678.90', '999'])(
    'still accepts %s, where the grouping is valid',
    (input) => {
      expect(parse(input).ok).toBe(true);
    },
  );

  it('rejects an amount beyond safe integer range', () => {
    const r = parse('99999999999999999999');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.tag).toBe('not_finite');
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(unwrapOrThrow(add(usd(1050), usd(2075))).cents).toBe(3125);
    expect(unwrapOrThrow(subtract(usd(1050), usd(2075))).cents).toBe(-1025);
  });

  it('never drifts the way floats do', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; 10c + 20c === 30c always.
    expect(unwrapOrThrow(sum([usd(10), usd(20)])).cents).toBe(30);
  });

  it('sums an empty list to zero', () => {
    expect(unwrapOrThrow(sum([])).cents).toBe(0);
  });

  it('multiplies by a whole quantity', () => {
    expect(unwrapOrThrow(times(usd(1299), 3)).cents).toBe(3897);
  });

  it('refuses a fractional quantity', () => {
    const r = times(usd(100), 1.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.tag).toBe('fractional_quantity');
  });

  it('reports a currency mismatch instead of adding unlike amounts', () => {
    const r = add(usd(100), notUsd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.tag).toBe('currency_mismatch');
  });

  it('propagates a mismatch out of subtract and sum', () => {
    expect(subtract(usd(100), notUsd).ok).toBe(false);
    expect(sum([usd(1), notUsd]).ok).toBe(false);
  });

  it('negates, compares and equates', () => {
    expect(negate(usd(500)).cents).toBe(-500);
    expect(isNegative(usd(-1))).toBe(true);
    expect(isNegative(usd(0))).toBe(false);
    expect(compare(usd(200), usd(100))).toBeGreaterThan(0);
    expect(compare(usd(100), usd(200))).toBeLessThan(0);
    expect(equals(usd(100), usd(100))).toBe(true);
    expect(equals(usd(100), usd(101))).toBe(false);
    expect(equals(usd(100), notUsd)).toBe(false);
  });
});

describe('rounding and rates', () => {
  it('rounds half away from zero, symmetrically', () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
    // 3, not 2 — banker's rounding would give 2 here.
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-0.5)).toBe(-1);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(1.4)).toBe(1);
    expect(roundHalfUp(-1.4)).toBe(-1);
  });

  it('applies VAT at 11% and rounds to whole cents', () => {
    // 1299c * 0.11 = 142.89c -> 143c
    expect(unwrapOrThrow(applyRate(usd(1299), 0.11)).cents).toBe(143);
  });

  it('applies a rate to a negative amount symmetrically', () => {
    expect(unwrapOrThrow(applyRate(usd(-1299), 0.11)).cents).toBe(-143);
  });

  it('rejects a non-finite rate', () => {
    expect(applyRate(usd(100), Number.NaN).ok).toBe(false);
  });
});

describe('formatting', () => {
  it('formats with exactly two fraction digits in every locale', () => {
    for (const locale of ['en', 'ar', 'fr'] as const) {
      expect(format(usd(129900), locale)).toMatch(/299[.,]00/);
    }
  });

  it('uses Latin digits even in Arabic', () => {
    expect(format(usd(1250), 'ar')).toMatch(/12[.,]50/);
  });

  it('defaults to English when no locale is given', () => {
    expect(format(usd(1250))).toContain('12.50');
  });

  it('renders a machine-readable decimal string for feeds and JSON-LD', () => {
    expect(toDecimalString(usd(129999))).toBe('1299.99');
    expect(toDecimalString(usd(5))).toBe('0.05');
    expect(toDecimalString(usd(0))).toBe('0.00');
    expect(toDecimalString(usd(-420))).toBe('-4.20');
  });
});

describe('scaleByBasisPoints', () => {
  it('leaves the amount alone at 10000', () => {
    expect(unwrapOrThrow(scaleByBasisPoints(usd(1999), 10_000)).cents).toBe(1999);
  });

  it('raises by five percent, rounding half away from zero', () => {
    // 1999 * 1.05 = 2098.95 -> 2099. Through a float rate this is
    // 2098.9500000000003 first, which is why the multiplier is an integer.
    expect(unwrapOrThrow(scaleByBasisPoints(usd(1999), 10_500)).cents).toBe(2099);
  });

  it('lowers by five percent', () => {
    // 1999 * 0.95 = 1899.05 -> 1899
    expect(unwrapOrThrow(scaleByBasisPoints(usd(1999), 9_500)).cents).toBe(1899);
  });

  it('rounds a half cent away from zero, not to even', () => {
    // 10 * 1.05 = 10.5 -> 11, matching what a customer computes in their head.
    expect(unwrapOrThrow(scaleByBasisPoints(usd(10), 10_500)).cents).toBe(11);
  });

  it('rounds a negative half cent away from zero too', () => {
    expect(unwrapOrThrow(scaleByBasisPoints(usd(-10), 10_500)).cents).toBe(-11);
  });

  it('handles zero', () => {
    expect(unwrapOrThrow(scaleByBasisPoints(usd(0), 12_345)).cents).toBe(0);
  });

  it('can take a price to zero', () => {
    expect(unwrapOrThrow(scaleByBasisPoints(usd(1999), 0)).cents).toBe(0);
  });

  it('keeps the currency', () => {
    expect(unwrapOrThrow(scaleByBasisPoints(usd(100), 11_000)).currency).toBe('USD');
  });

  it('rejects a fractional multiplier, because rounding must be explicit', () => {
    expect(scaleByBasisPoints(usd(100), 10_500.5)).toEqual({
      ok: false,
      error: { tag: 'not_an_integer', cents: 10_500.5 },
    });
  });

  it('rejects a multiplier that is not finite', () => {
    expect(scaleByBasisPoints(usd(100), Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it('rejects a product that leaves the exact-integer range', () => {
    // MAX_SAFE_INTEGER * 10^10 is still FINITE as a float — it has just stopped
    // being an exact integer. Guarding on isFinite would let it through and
    // round a number that was already wrong.
    const huge = scaleByBasisPoints(usd(Number.MAX_SAFE_INTEGER), 10_000_000_000);
    expect(huge.ok).toBe(false);
    expect(Number.isFinite(Number.MAX_SAFE_INTEGER * 10_000_000_000)).toBe(true);
  });

  it('is exact across a realistic price list', () => {
    // Every cent from $0.01 to $10.00 raised 5%: the result must equal the
    // decimal computation rounded half up, with no drift anywhere.
    for (let cents = 1; cents <= 1000; cents++) {
      const expected = Math.round((cents * 105) / 100);
      expect(unwrapOrThrow(scaleByBasisPoints(usd(cents), 10_500)).cents).toBe(expected);
    }
  });
});
