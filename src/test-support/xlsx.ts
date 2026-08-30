/**
 * Real .xlsx bytes, built here rather than by a library.
 *
 * WHY NOT `write-excel-file`
 * -------------------------
 * The obvious way to make a fixture is the reader's companion writer. It is the
 * wrong way for this reader, because the one question worth asking is what a
 * DATE cell turns into — and a writer by the same author, working from the same
 * model of what a date is, would encode whatever the reader decodes. The test
 * would round-trip cleanly while both halves were wrong together, which is the
 * shape of every check in this repository that turned out to prove nothing.
 *
 * So the workbook is assembled from the format itself: a ZIP of XML parts, with
 * every date written as the serial number the spreadsheet file actually stores.
 * The test picks that number from the epoch anchor below — 1970-01-01 is serial
 * 25569 — and nothing in `src/` participates in choosing it.
 *
 * WHAT IS HERE
 * ------------
 * Enough of the format for a reader to open: content types, the two rels parts,
 * a workbook, one styles part carrying a date format, shared strings, and a
 * sheet per `Sheet` given. Entries are STORED rather than deflated, because a
 * CRC and a length are the whole of what a ZIP needs and compressing a
 * two-kilobyte fixture buys nothing.
 */

/** One cell, in the terms the FILE stores rather than the terms JavaScript uses. */
export type Cell =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  /** The raw Excel serial. Tests choose it with `excelSerial`, never from a Date. */
  | { readonly kind: 'dateSerial'; readonly value: number }
  | { readonly kind: 'blank' };

export type Sheet = { readonly name: string; readonly rows: readonly (readonly Cell[])[] };

/**
 * The serial number a spreadsheet stores for a calendar date.
 *
 * 1970-01-01 is 25569, which is the anchor every implementation agrees on, and
 * from there it is a count of whole days. Deriving it this way rather than from
 * the 1900 epoch sidesteps the leap-year bug entirely: the bug is before 1970,
 * and this shop's dates are not.
 */
export const excelSerial = (isoDate: string): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (match === null) throw new Error(`not a calendar date: ${isoDate}`);
  const [, year, month, day] = match;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return 25569 + utc / 86_400_000;
};

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A1, B1 … Z1, AA1. More columns than any fixture here needs, and no special case at 26. */
const columnName = (index: number): string => {
  let name = '';
  let remaining = index;
  while (remaining >= 0) {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  }
  return name;
};

/* ---------------------------------------------------------------- ZIP ---- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number);
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
};

type Entry = { readonly name: string; readonly bytes: Uint8Array };

/**
 * A ZIP archive with every entry STORED.
 *
 * Local header, then data, then one central-directory record each, then the end
 * record. A fixed 1980-01-01 timestamp, because a fixture that differs run to
 * run is one whose failures cannot be compared.
 */
const zip = (entries: readonly Entry[]): Uint8Array => {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (view: DataView, at: number, value: number) => view.setUint16(at, value, true);
  const u32 = (view: DataView, at: number, value: number) => view.setUint32(at, value, true);

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    u32(localView, 0, 0x04_03_4b_50);
    u16(localView, 4, 20); // version needed
    u16(localView, 8, 0); // stored
    u16(localView, 10, 0); // time
    u16(localView, 12, 0x00_21); // date: 1980-01-01
    u32(localView, 14, crc);
    u32(localView, 18, entry.bytes.length);
    u32(localView, 22, entry.bytes.length);
    u16(localView, 26, name.length);
    local.set(name, 30);

    const record = new Uint8Array(46 + name.length);
    const recordView = new DataView(record.buffer);
    u32(recordView, 0, 0x02_01_4b_50);
    u16(recordView, 4, 20); // version made by
    u16(recordView, 6, 20); // version needed
    u16(recordView, 10, 0); // stored
    u16(recordView, 12, 0);
    u16(recordView, 14, 0x00_21);
    u32(recordView, 16, crc);
    u32(recordView, 20, entry.bytes.length);
    u32(recordView, 24, entry.bytes.length);
    u16(recordView, 28, name.length);
    u32(recordView, 42, offset);
    record.set(name, 46);

    parts.push(local, entry.bytes);
    central.push(record);
    offset += local.length + entry.bytes.length;
  }

  const centralSize = central.reduce((total, record) => total + record.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  u32(endView, 0, 0x06_05_4b_50);
  u16(endView, 8, entries.length);
  u16(endView, 10, entries.length);
  u32(endView, 12, centralSize);
  u32(endView, 16, offset);

  const all = [...parts, ...central, end];
  const total = all.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of all) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

/* -------------------------------------------------------------- parts ---- */

/**
 * `s="1"` is the date style.
 *
 * A date in a spreadsheet is a number wearing a format: cellXfs entry 1 points
 * at numFmtId 14, the built-in short date. That pairing — a plain serial plus a
 * date format — is the whole of what makes a reader hand back a Date rather
 * than a number, which is exactly the mechanism under test.
 */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font/></fonts>
<fills count="1"><fill/></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="2"><xf/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>
</styleSheet>`;

/**
 * One `<c>` element, or nothing at all for a gap.
 *
 * A blank writes NO element rather than an empty one, because that is what a
 * spreadsheet does — which is the whole point of the ragged-row test: the
 * reader has to put the gap back before anything reads a row by column index.
 */
const cellXml = (cell: Cell, ref: string, stringIndex: Map<string, number>): string => {
  if (cell.kind === 'blank') return '';
  if (cell.kind === 'text') return `<c r="${ref}" t="s"><v>${stringIndex.get(cell.value)}</v></c>`;
  if (cell.kind === 'number') return `<c r="${ref}"><v>${cell.value}</v></c>`;
  if (cell.kind === 'boolean') return `<c r="${ref}" t="b"><v>${cell.value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" s="1"><v>${cell.value}</v></c>`;
};

const sheetXml = (rows: readonly (readonly Cell[])[], stringIndex: Map<string, number>): string => {
  const body = rows
    .map((cells, rowIndex) => {
      const row = rowIndex + 1;
      const written = cells
        .map((cell, columnIndex) => cellXml(cell, `${columnName(columnIndex)}${row}`, stringIndex))
        .join('');
      return `<row r="${row}">${written}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
};

/** The bytes of a workbook holding these sheets, in this order. */
export const buildWorkbook = (sheets: readonly Sheet[]): Uint8Array => {
  const encoder = new TextEncoder();

  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      for (const cell of row) {
        if (cell.kind !== 'text' || stringIndex.has(cell.value)) continue;
        stringIndex.set(cell.value, strings.length);
        strings.push(cell.value);
      }
    }
  }

  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings
    .map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`)
    .join('')}</sst>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('')}</sheets></workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map(
      (_sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join(
      '',
    )}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdStrings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
    .map(
      (_sheet, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join(
      '',
    )}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  return zip([
    { name: '[Content_Types].xml', bytes: encoder.encode(contentTypes) },
    { name: '_rels/.rels', bytes: encoder.encode(rootRels) },
    { name: 'xl/workbook.xml', bytes: encoder.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', bytes: encoder.encode(workbookRels) },
    { name: 'xl/styles.xml', bytes: encoder.encode(STYLES) },
    { name: 'xl/sharedStrings.xml', bytes: encoder.encode(sharedStrings) },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      bytes: encoder.encode(sheetXml(sheet.rows, stringIndex)),
    })),
  ]);
};

/* ----------------------------------------------------------- shorthand ---- */

export const text = (value: string): Cell => ({ kind: 'text', value });
export const number = (value: number): Cell => ({ kind: 'number', value });
export const boolean = (value: boolean): Cell => ({ kind: 'boolean', value });
export const dateCell = (isoDate: string): Cell => ({
  kind: 'dateSerial',
  value: excelSerial(isoDate),
});
export const blank: Cell = { kind: 'blank' };
