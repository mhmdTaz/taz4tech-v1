/**
 * Money — USD, stored as an integer number of cents.
 *
 * Never a float. 0.1 + 0.2 !== 0.3 in IEEE-754, and an order total that is off
 * by a cent is a cash-on-delivery argument at the customer's door. Every amount
 * in this system — prices, line totals, VAT, delivery fees, driver cash — is an
 * integer count of the minor unit.
 *
 * Safe range: 2^53 - 1 cents is about $90 trillion. Not a constraint here.
 *
 * The store is USD-only today (a locked decision), but Money still carries an
 * explicit currency so that adding LBP later is a type change the compiler
 * walks you through, rather than a silent reinterpretation of every integer.
 */

import { err, ok, type Result } from '../result';
import type { Currency, Money, MoneyError } from './types';

export { allocate } from './allocate';
export type { Currency, Money, MoneyError } from './types';

export const USD: Currency = 'USD';

export const zero = (currency: Currency = USD): Money => ({ cents: 0, currency });

/** Build from an integer count of cents. Rejects floats — rounding must be explicit. */
export const fromCents = (cents: number, currency: Currency = USD): Result<Money, MoneyError> => {
  if (!Number.isFinite(cents)) return err({ tag: 'not_finite', cents });
  if (!Number.isInteger(cents)) return err({ tag: 'not_an_integer', cents });
  return ok({ cents, currency });
};

/**
 * Parse a human-entered amount: "12", "12.5", "12.50", "$1,299.99", "-4.20".
 *
 * Parsed as a decimal string, NOT via parseFloat — "1.115" through a float
 * round-trip lands on 1.1149999999999998 and silently truncates to 111 cents
 * instead of 112. Here the fractional digits are read as characters.
 */
export const parse = (input: string, currency: Currency = USD): Result<Money, MoneyError> => {
  const cleaned = input.trim().replace(/[$\s,]/g, '');
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) return err({ tag: 'unparsable', input });

  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2]);
  const fraction = (match[3] ?? '').padEnd(2, '0');
  const cents = sign * (whole * 100 + Number(fraction));

  if (!Number.isSafeInteger(cents)) return err({ tag: 'not_finite', cents });
  return ok({ cents, currency });
};

const sameCurrency = (a: Money, b: Money): Result<Currency, MoneyError> =>
  a.currency === b.currency
    ? ok(a.currency)
    : err({ tag: 'currency_mismatch', left: a.currency, right: b.currency });

export const add = (a: Money, b: Money): Result<Money, MoneyError> => {
  const c = sameCurrency(a, b);
  return c.ok ? ok({ cents: a.cents + b.cents, currency: c.value }) : c;
};

export const subtract = (a: Money, b: Money): Result<Money, MoneyError> => {
  const c = sameCurrency(a, b);
  return c.ok ? ok({ cents: a.cents - b.cents, currency: c.value }) : c;
};

export const sum = (
  amounts: readonly Money[],
  currency: Currency = USD,
): Result<Money, MoneyError> => {
  let total = zero(currency);
  for (const amount of amounts) {
    const next = add(total, amount);
    if (!next.ok) return next;
    total = next.value;
  }
  return ok(total);
};

/** Multiply by a whole quantity. Exact — no rounding involved. */
export const times = (a: Money, quantity: number): Result<Money, MoneyError> => {
  if (!Number.isInteger(quantity)) return err({ tag: 'fractional_quantity', quantity });
  return ok({ cents: a.cents * quantity, currency: a.currency });
};

export const negate = (a: Money): Money => ({ cents: -a.cents, currency: a.currency });
export const isZero = (a: Money): boolean => a.cents === 0;
export const isNegative = (a: Money): boolean => a.cents < 0;
export const compare = (a: Money, b: Money): number => a.cents - b.cents;
export const equals = (a: Money, b: Money): boolean =>
  a.cents === b.cents && a.currency === b.currency;

/**
 * Round half away from zero — 0.5c becomes 1c, -0.5c becomes -1c.
 *
 * Chosen over banker's rounding because it is what a customer computes in their
 * head and what Lebanese VAT invoices show. Banker's rounding is fairer across
 * a large population of transactions but produces receipts a customer disputes.
 */
export const roundHalfUp = (exactCents: number): number =>
  exactCents < 0 ? -Math.round(-exactCents) : Math.round(exactCents);

/**
 * Apply a rate (VAT 11% -> 0.11, a 15% discount -> 0.15) and round to whole cents.
 * Always rounded at the point of application, so the caller can never accumulate
 * fractional cents by accident.
 */
export const applyRate = (a: Money, rate: number): Result<Money, MoneyError> => {
  if (!Number.isFinite(rate)) return err({ tag: 'not_finite', cents: rate });
  return ok({ cents: roundHalfUp(a.cents * rate), currency: a.currency });
};

/** Format for display. Latin digits everywhere, including ar — see the note below. */
export const format = (a: Money, locale: 'en' | 'ar' | 'fr' = 'en'): string =>
  new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: a.currency,
    numberingSystem: 'latn',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(a.cents / 100);

/** Machine-readable form for JSON-LD, feeds and APIs: "1299.99". */
export const toDecimalString = (a: Money): string => {
  const sign = a.cents < 0 ? '-' : '';
  const abs = Math.abs(a.cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};
