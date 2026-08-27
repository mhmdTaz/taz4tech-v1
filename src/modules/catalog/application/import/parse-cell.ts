/**
 * Turning spreadsheet cells into typed values.
 *
 * Every function here refuses to guess. An importer that quietly interprets an
 * ambiguous cell is worse than one that stops and asks, because the damage shows
 * up later as a wrong price on an invoice rather than immediately as an error
 * next to row 412.
 */

import { type Money, parse as parseMoney } from '@platform/money';
import type { ProductStatus } from '../../domain/product';

export type CellProblem =
  | { readonly tag: 'required_cell_empty' }
  | { readonly tag: 'unparsable_money'; readonly value: string }
  | { readonly tag: 'ambiguous_date'; readonly value: string }
  | { readonly tag: 'unparsable_date'; readonly value: string }
  | { readonly tag: 'unknown_status'; readonly value: string }
  | { readonly tag: 'unparsable_number'; readonly value: string }
  | { readonly tag: 'duplicate_sku'; readonly firstSeenAtRow: number };

export type CellResult<T> = { ok: true; value: T } | { ok: false; error: CellProblem };

const ok = <T>(value: T): CellResult<T> => ({ ok: true, value });
const bad = <T>(error: CellProblem): CellResult<T> => ({ ok: false, error });

export const isBlank = (cell: string | undefined): boolean =>
  cell === undefined || cell.trim().length === 0;

export const text = (cell: string | undefined): string => (cell ?? '').trim();

/** Optional text: blank becomes null rather than an empty string. */
export const optionalText = (cell: string | undefined): string | null =>
  isBlank(cell) ? null : text(cell);

export const requiredText = (cell: string | undefined): CellResult<string> =>
  isBlank(cell) ? bad({ tag: 'required_cell_empty' }) : ok(text(cell));

/** Money via the platform parser, which reads decimals as digits rather than floats. */
export const money = (cell: string | undefined): CellResult<Money> => {
  if (isBlank(cell)) return bad({ tag: 'required_cell_empty' });

  // Strip a trailing currency word — "1,299.00 USD" is common in supplier sheets.
  const cleaned = text(cell).replace(/\s*(usd|\$)\s*$/i, '');
  const parsed = parseMoney(cleaned);
  return parsed.ok ? ok(parsed.value) : bad({ tag: 'unparsable_money', value: text(cell) });
};

export const optionalMoney = (cell: string | undefined): CellResult<Money | null> =>
  isBlank(cell) ? ok(null) : money(cell);

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASHED = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

/**
 * Dates, ISO only.
 *
 * `03/04/2026` is 3 April to a Lebanese supplier and 4 March to an American one,
 * and nothing in the file says which. Guessing would set an offer expiry up to
 * eight months wrong — on the field consumer protection law requires to be
 * accurate, and that Google reads as priceValidUntil.
 *
 * So a slashed date is rejected as AMBIGUOUS rather than parsed, with its own
 * tag so the UI can say "write it as 2026-04-03" instead of "invalid date".
 * Excel's own date cells arrive already normalised to ISO by the reader.
 */
export const date = (cell: string | undefined): CellResult<Date> => {
  if (isBlank(cell)) return bad({ tag: 'required_cell_empty' });
  const raw = text(cell);

  if (SLASHED.test(raw)) return bad({ tag: 'ambiguous_date', value: raw });

  const match = ISO_DATE.exec(raw);
  if (match === null) return bad({ tag: 'unparsable_date', value: raw });

  const [, year, month, day] = match;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00.000Z`);

  // Catches 2026-02-31, which Date would silently roll into March.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    return bad({ tag: 'unparsable_date', value: raw });
  }
  return ok(parsed);
};

export const optionalDate = (cell: string | undefined): CellResult<Date | null> =>
  isBlank(cell) ? ok(null) : date(cell);

const STATUS_WORDS: Record<string, ProductStatus> = {
  active: 'active',
  published: 'active',
  yes: 'active',
  true: 'active',
  '1': 'active',
  draft: 'draft',
  unpublished: 'draft',
  no: 'draft',
  false: 'draft',
  '0': 'draft',
  archived: 'archived',
  inactive: 'archived',
};

/**
 * Status, defaulting to draft.
 *
 * Draft rather than active is the whole point: an import of four hundred rows
 * should not publish four hundred products to customers because the sheet had no
 * status column. Publishing is a decision, and it stays a separate one.
 */
export const status = (cell: string | undefined): CellResult<ProductStatus> => {
  if (isBlank(cell)) return ok('draft');
  const word = text(cell).toLowerCase();
  const mapped = STATUS_WORDS[word];
  return mapped === undefined ? bad({ tag: 'unknown_status', value: text(cell) }) : ok(mapped);
};

/** A non-negative whole number, e.g. weight in grams. */
export const optionalInteger = (cell: string | undefined): CellResult<number | null> => {
  if (isBlank(cell)) return ok(null);
  const raw = text(cell).replace(/[\s,]/g, '');
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return bad({ tag: 'unparsable_number', value: text(cell) });
  }
  return ok(value);
};
