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

/** Excel dates carry no timezone; treat them as the calendar date shown in the cell. */
const isoDate = (value: Date): string =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(
    value.getDate(),
  ).padStart(2, '0')}`;

const toText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return isoDate(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
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
    if (!Array.isArray(raw)) {
      throw new Error('spreadsheet did not parse into rows');
    }

    /*
     * The reader returns EITHER rows, or a list of sheets shaped
     * [{ sheet, data }] — which is what the library's own `Sheet` type was
     * signalling. Only the first sheet is imported: a catalogue workbook
     * routinely carries a "Notes" or "Prices 2024" tab beside the real one, and
     * silently concatenating them would import last year's prices.
     */
    const first = raw[0];
    const rows =
      first !== null && typeof first === 'object' && !Array.isArray(first) && 'data' in first
        ? ((first as { data: unknown }).data ?? [])
        : raw;

    if (!Array.isArray(rows)) throw new Error('spreadsheet did not parse into rows');
    return rows.map((row) => (Array.isArray(row) ? row.map(toText) : []));
  },
});
