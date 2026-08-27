/**
 * Phone numbers.
 *
 * THE PHONE NUMBER IS THE CUSTOMER IDENTITY IN THIS SYSTEM.
 *
 * There are no accounts. An order is found by phone, a delivery is arranged by
 * phone, and Phase 4's loyalty is keyed on it. So it is stored in exactly one
 * shape — E.164, `+9613123456` — and every place a human types one goes through
 * here. Two records for one customer because one was typed `03 123 456` and the
 * other `+961 3 123 456` is the failure this prevents.
 *
 * FORGIVING ON THE WAY IN, STRICT ON THE WAY OUT
 * ----------------------------------------------
 * A customer on a phone types what they always type: `03 123 456`, `70 123 456`,
 * `+961 3 123 456`, `00961...`. All of those are the same number and all are
 * accepted. What is NOT accepted is anything ambiguous — the same rule the
 * importer applies to dates. Guessing a digit wrong means a delivery that never
 * arrives and a customer nobody can call.
 */

import { err, ok, type Result } from '@platform/result';

/** Lebanon. The only country this shop delivers to. */
export const LEBANON_CALLING_CODE = '961';

export type PhoneError =
  | { readonly tag: 'empty' }
  | { readonly tag: 'not_a_number'; readonly input: string }
  | { readonly tag: 'wrong_length'; readonly input: string }
  | { readonly tag: 'not_lebanese'; readonly input: string };

/** E.164 without the plus, e.g. `9613123456`. Branded so it cannot be confused with raw input. */
export type E164 = string;

/**
 * A Lebanese national number is 7 or 8 digits after the country code.
 *
 * Seven for the older mobile range (3XXXXXX) and most landlines; eight for the
 * 7X and 8X mobile ranges. Anything outside that is a typo, not a number.
 */
const MIN_NATIONAL_DIGITS = 7;
const MAX_NATIONAL_DIGITS = 8;

/** Everything a human might type between digits, and nothing else. */
const stripSeparators = (input: string): string => input.replace(/[\s\-().]/g, '');

const isDigits = (value: string): boolean => value.length > 0 && /^\d+$/.test(value);

/**
 * Normalise a Lebanese phone number to E.164.
 *
 * Returns `+961XXXXXXX`. Refuses rather than guesses: a number that could be
 * read two ways is a number that will reach the wrong person.
 */
export const parseLebanesePhone = (input: string): Result<string, PhoneError> => {
  const trimmed = input.trim();
  if (trimmed.length === 0) return err({ tag: 'empty' });

  let digits = stripSeparators(trimmed);

  // 00 is how the rest of the world writes a leading +.
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;

  if (digits.startsWith('+')) {
    const rest = digits.slice(1);
    if (!isDigits(rest)) return err({ tag: 'not_a_number', input });

    // An international number that is not Lebanese is refused rather than
    // stored: this shop delivers to Lebanon, and a number it cannot call is
    // worse than an empty field, which at least reads as missing.
    if (!rest.startsWith(LEBANON_CALLING_CODE)) return err({ tag: 'not_lebanese', input });

    return national(rest.slice(LEBANON_CALLING_CODE.length), input);
  }

  if (!isDigits(digits)) return err({ tag: 'not_a_number', input });

  // A leading zero is the national trunk prefix, dropped in E.164. `03 123 456`
  // and `+961 3 123 456` are the same number written two ways.
  if (digits.startsWith('0')) return national(digits.slice(1), input);

  return national(digits, input);
};

const national = (digits: string, input: string): Result<string, PhoneError> => {
  if (!isDigits(digits)) return err({ tag: 'not_a_number', input });
  if (digits.length < MIN_NATIONAL_DIGITS || digits.length > MAX_NATIONAL_DIGITS) {
    return err({ tag: 'wrong_length', input });
  }
  return ok(`+${LEBANON_CALLING_CODE}${digits}`);
};

/** Whether a stored value is already in the one shape this system keeps. */
export const isE164 = (value: string): boolean => /^\+[1-9]\d{7,14}$/.test(value);

/**
 * For reading aloud and for a `tel:` link: `+961 3 123 456`.
 *
 * Grouping only — the stored value never changes shape, because everything that
 * matches or looks up a customer matches on the stored one.
 */
export const formatForDisplay = (e164: string): string => {
  if (!e164.startsWith(`+${LEBANON_CALLING_CODE}`)) return e164;

  const rest = e164.slice(`+${LEBANON_CALLING_CODE}`.length);
  if (rest.length === MIN_NATIONAL_DIGITS) {
    return `+${LEBANON_CALLING_CODE} ${rest.slice(0, 1)} ${rest.slice(1, 4)} ${rest.slice(4)}`;
  }
  if (rest.length === MAX_NATIONAL_DIGITS) {
    return `+${LEBANON_CALLING_CODE} ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`;
  }
  return e164;
};

/** The number as WhatsApp wants it in a wa.me link: digits only, no plus. */
export const toWhatsAppNumber = (e164: string): string => e164.replace(/^\+/, '');
