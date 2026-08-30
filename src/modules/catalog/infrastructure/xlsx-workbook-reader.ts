/**
 * Reads .xlsx into rows of text.
 *
 * The only file-format-aware code in the importer. Everything downstream sees
 * string[][], which is why the import engine's tests are plain arrays rather
 * than binary fixtures.
 *
 * Two normalisations happen here and nowhere else:
 *
 * 1. Dates become ISO (YYYY-MM-DD). Excel stores a date as a serial number and
 *    the reader hands back a Date; formatting it here is what lets the engine
 *    refuse ambiguous DD/MM text while still accepting a real Excel date cell.
 * 2. Numbers become plain strings without locale formatting, so the money parser
 *    sees "1299.5" rather than whatever the sheet's display format was.
 */

import readXlsxFile from 'read-excel-file/node';
import type { WorkbookReader } from '../contracts';

/**
 * The calendar date shown in the cell, read in UTC.
 *
 * A spreadsheet date has no timezone — it is a day, not an instant — and the
 * reader represents it as a Date at UTC MIDNIGHT of that day. That is the same
 * instant whatever machine opens the file, checked from Anchorage to Kiritimati.
 *
 * So the components have to be read in UTC too. Reading them locally moves the
 * day back by one wherever the offset is negative: on a machine in the Americas
 * every date in the sheet would import a day early, which on `offerEndsAt` means
 * a promotion that ends today arrives already expired — cleared by the domain,
 * and reported to the operator as a typo they did not make.
 */
const isoDate = (value: Date): string =>
  `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(
    value.getUTCDate(),
  ).padStart(2, '0')}`;

/**
 * One cell as text.
 *
 * Three cases, not five. There used to be a branch for numbers and a branch for
 * booleans, and mutation testing killed neither: `String(1299.5)` is what the
 * number branch returned, and `String(true)` is the word the boolean branch
 * spelled out. Both said out loud what the last line already does, which reads
 * as care and tested as nothing.
 *
 * The two that remain do change the answer. `String(null)` is the word "null",
 * which would import as a title; and a Date has to be formatted rather than
 * stringified, or every date cell arrives as "Thu Aug 27 2026 …".
 *
 * The trim is a second layer over the library's own, kept for an untrusted
 * boundary rather than because anything reaches it — see the declaration in
 * `scripts/check-static-mutants.mjs`.
 */
const toText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return isoDate(value);
  return String(value).trim();
};

export const createXlsxWorkbookReader = (): WorkbookReader => ({
  async readRows(file: Uint8Array): Promise<string[][]> {
    /*
     * Narrowed rather than cast. This is an untrusted-input boundary — the file
     * came from a browser upload — and the library's own types are loose enough
     * to be worth not trusting: its CellValue says `typeof Date` where it means
     * `Date`, so a cast would hand the rest of the system a shape that does not
     * match reality.
     */
    const raw: unknown = await readXlsxFile(Buffer.from(file));
    if (!Array.isArray(raw)) throw new Error('spreadsheet did not parse into sheets');

    /*
     * ONE ENTRY PER SHEET, shaped { sheet, data } — for a single-sheet workbook
     * as much as for a five-sheet one. This used to accept a bare list of rows
     * as well, on the strength of the library's loose types; the library does
     * not produce one, and a branch that cannot be taken is a branch nothing
     * checks. `xlsx-workbook-reader.test.ts` asserts the shape against the
     * library directly, so an upgrade that changes it fails there rather than
     * on an operator's import.
     *
     * Only the FIRST sheet is read: a catalogue workbook routinely carries a
     * "Notes" or "Prices 2024" tab beside the real one, and concatenating them
     * would import last year's prices.
     */
    const [first] = raw;
    if (first === undefined) return [];

    const rows = (first as { data?: unknown }).data;
    if (!Array.isArray(rows)) throw new Error('first sheet did not parse into rows');

    return rows.map((row) => (Array.isArray(row) ? row.map(toText) : []));
  },
});
