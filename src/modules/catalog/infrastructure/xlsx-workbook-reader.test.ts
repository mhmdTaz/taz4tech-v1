import { describe, expect, it } from 'vitest';
import {
  blank,
  boolean,
  buildWorkbook,
  dateCell,
  excelSerial,
  number,
  text,
} from '@/test-support/xlsx';
import { createXlsxWorkbookReader } from './xlsx-workbook-reader';

const read = (bytes: Uint8Array) => createXlsxWorkbookReader().readRows(bytes);

const oneSheet = (rows: readonly (readonly ReturnType<typeof text>[])[]) =>
  buildWorkbook([{ name: 'Catalogue', rows }]);

describe('reading a supplier workbook', () => {
  it('hands back the cells as text, row by row', async () => {
    const rows = await read(
      oneSheet([
        [text('SKU'), text('Title')],
        [text('A-1'), text('Anker Cable')],
      ]),
    );

    expect(rows).toEqual([
      ['SKU', 'Title'],
      ['A-1', 'Anker Cable'],
    ]);
  });
});

describe('the serial helper the fixtures use', () => {
  it('agrees with the anchor every spreadsheet agrees on', () => {
    // 1970-01-01 is 25569. Stated here rather than derived, so the helper the
    // date tests depend on is itself pinned to something outside this file.
    expect(excelSerial('1970-01-01')).toBe(25569);
    expect(excelSerial('1970-01-02')).toBe(25570);
    expect(excelSerial('2026-08-27')).toBe(46261);
  });
});

describe('a date cell', () => {
  it('arrives as the calendar date the sheet shows', async () => {
    const rows = await read(oneSheet([[text('Offer Ends At')], [dateCell('2026-08-27')]]));
    expect(rows[1]?.[0]).toBe('2026-08-27');
  });
});

/**
 * Reads `bytes` as though the machine were somewhere else.
 *
 * Node re-reads the zone from `process.env.TZ`, so this changes what
 * `getDate()` answers for the very same instant. The window is one await long
 * and the previous value goes back in a finally — and the unit project gives
 * each file its own process, so nothing else is looking while it is set.
 */
const readFrom = async (zone: string, bytes: Uint8Array) => {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await read(bytes);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
};

describe('a date cell, read from a machine west of Greenwich', () => {
  it('is STILL the date the sheet shows', async () => {
    /*
     * The library hands back a Date at UTC midnight for the calendar date in
     * the cell — the same instant from Anchorage to Sydney, checked in six
     * zones. Formatting that with local getters moves the day back by one
     * wherever the offset is negative, so an operator importing from anywhere
     * in the Americas would have every date land a day early.
     *
     * On `offerEndsAt` that is the field consumer protection law requires to be
     * accurate, and the field the importer reports "already past" against: a
     * promotion ending today would import as ended yesterday, be cleared by the
     * domain, and be reported as a typo the operator did not make.
     *
     * Both a summer and a winter date, because New York is -4 in August and -5
     * in January and a fix that only worked outside daylight saving would look
     * exactly like a fix.
     */
    const rows = await readFrom(
      'America/New_York',
      oneSheet([[text('Offer Ends At')], [dateCell('2026-08-27')], [dateCell('2026-01-15')]]),
    );

    expect([rows[1]?.[0], rows[2]?.[0]]).toEqual(['2026-08-27', '2026-01-15']);
  });

  it('reads the same from the two zones furthest apart', async () => {
    // Kiritimati is +14 and Anchorage is -9: 23 hours between them, which is
    // every offset a calendar date can be read under.
    const sheet = () => oneSheet([[text('D')], [dateCell('2026-08-27')]]);

    expect((await readFrom('Pacific/Kiritimati', sheet()))[1]?.[0]).toBe('2026-08-27');
    expect((await readFrom('America/Anchorage', sheet()))[1]?.[0]).toBe('2026-08-27');
  });
});

describe('a date in the first nine of a month', () => {
  it('is padded to two digits on both halves', async () => {
    // "2026-1-5" is not an ISO date and the cell parser refuses it outright, so
    // an unpadded day would turn every early-in-the-month offer into an
    // unparsable_date the operator cannot act on. Every other date here has a
    // two-digit day already, which is a padding bug's favourite hiding place.
    const rows = await read(oneSheet([[text('D')], [dateCell('2026-01-05')]]));
    expect(rows[1]?.[0]).toBe('2026-01-05');
  });
});

describe('a number cell', () => {
  it('keeps a barcode as digits rather than turning it into notation', async () => {
    const rows = await read(oneSheet([[text('Barcode')], [number(5_901_234_123_457)]]));
    expect(rows[1]?.[0]).toBe('5901234123457');
  });

  it('drops the display format and hands over the stored amount', async () => {
    // "$1,299.50" in the cell is 1299.5 in the file, and the money parser wants
    // the second one — it refuses a comma rather than guessing at it.
    const rows = await read(oneSheet([[text('Price')], [number(1299.5)]]));
    expect(rows[1]?.[0]).toBe('1299.5');
  });

  it('leaves a whole number whole', async () => {
    // Not "39.0" and not "39.00": the money parser reads the fraction as
    // characters, so a decimal point that is not there must not appear.
    const rows = await read(oneSheet([[text('Price')], [number(39)]]));
    expect(rows[1]?.[0]).toBe('39');
  });
});

describe('a boolean cell', () => {
  it('becomes a word the status parser already knows', async () => {
    const rows = await read(oneSheet([[text('Status')], [boolean(true)], [boolean(false)]]));
    expect([rows[1]?.[0], rows[2]?.[0]]).toEqual(['true', 'false']);
  });
});

describe('a blank cell', () => {
  it('is an empty string, not a hole in the row', async () => {
    const rows = await read(
      oneSheet([
        [text('A'), text('B')],
        [text('x'), blank],
      ]),
    );
    expect(rows[1]).toEqual(['x', '']);
  });
});

describe('text a supplier actually typed', () => {
  it('comes back trimmed', async () => {
    /*
     * Sheets are full of these. A SKU with a trailing space is a SKU that does
     * not match the one already in the catalogue, and the import creates a
     * second product instead of updating the first.
     *
     * WHAT THIS DOES NOT PROVE: that the trim in `toText` is what did it. The
     * library trims shared strings on its way out, and this test still passes
     * with `.trim()` deleted from the reader — checked, rather than assumed.
     * The requirement is real and belongs here; the reader's own trim is a
     * second layer that nothing can currently reach, and it is declared as such
     * rather than left looking tested.
     */
    const rows = await read(oneSheet([[text('SKU')], [text('  A-1  ')]]));
    expect(rows[1]?.[0]).toBe('A-1');
  });

  it("survives in all three of the shop's languages", async () => {
    // The titles go straight into the catalogue in Arabic and French, so this
    // is UTF-8 through the shared-strings table and out the other side.
    const rows = await read(
      oneSheet([
        [text('Title'), text('Title AR'), text('Title FR')],
        [text('Anker Cable'), text('كابل انكر'), text('Câble Anker')],
      ]),
    );

    expect(rows[1]).toEqual(['Anker Cable', 'كابل انكر', 'Câble Anker']);
  });
});

describe('a row shorter than the header', () => {
  it('does not shift the cells that ARE there', async () => {
    /*
     * Everything downstream reads by column INDEX — the mapping says "price is
     * column 2" — so a short row that collapsed its blanks would price a product
     * from its brand.
     */
    const rows = await read(
      oneSheet([
        [text('SKU'), text('Title'), text('Price'), text('Brand')],
        [text('A-1'), blank, number(19), blank],
      ]),
    );

    expect(rows[1]?.[0]).toBe('A-1');
    expect(rows[1]?.[2]).toBe('19');
  });
});

describe('a sheet with nothing in it', () => {
  it('is no rows rather than a failure', async () => {
    // An operator uploading the wrong file gets "the sheet is empty" from the
    // importer, which already has a test for it. It only gets there if this
    // returns rather than throws.
    expect(await read(oneSheet([]))).toEqual([]);
  });
});

describe('something that is not a workbook', () => {
  it('is refused rather than read as rubbish', async () => {
    // The file came from a browser upload. A PDF renamed .xlsx is a Tuesday,
    // and the importer turns this into `unreadable_file` for the operator.
    const notAWorkbook = new TextEncoder().encode('%PDF-1.7 this is not a spreadsheet');
    await expect(read(notAWorkbook)).rejects.toThrow();
  });
});

describe('the shape the library hands back', () => {
  /*
   * A contract test against the dependency, not against our code.
   *
   * The reader takes `[{ sheet, data }]` and nothing else — the two-shape
   * narrowing it used to carry was defending against a bare list of rows the
   * library never produces. That simplification is only safe while this stays
   * true, so it is asserted here rather than remembered: an upgrade that starts
   * returning rows directly fails this test, with the reason written next to it,
   * instead of failing an operator's import with "first sheet did not parse".
   */
  it('is one entry per sheet, even for a workbook with one', async () => {
    const readXlsxFile = (await import('read-excel-file/node')).default;

    for (const sheets of [
      [{ name: 'Only', rows: [[text('SKU')]] }],
      [
        { name: 'A', rows: [[text('SKU')]] },
        { name: 'B', rows: [[text('OLD')]] },
      ],
    ]) {
      const raw = (await readXlsxFile(Buffer.from(buildWorkbook(sheets)))) as unknown;

      expect(Array.isArray(raw)).toBe(true);
      expect(raw).toHaveLength(sheets.length);
      const first = (raw as unknown[])[0];
      expect(Array.isArray(first)).toBe(false);
      expect(Object.keys(first as object).sort()).toEqual(['data', 'sheet']);
    }
  });
});

describe('a workbook with more than one sheet', () => {
  it('imports the FIRST and ignores the rest', async () => {
    const rows = await read(
      buildWorkbook([
        { name: 'Catalogue', rows: [[text('SKU')], [text('A-1')]] },
        { name: 'Prices 2024', rows: [[text('SKU')], [text('OLD-1')]] },
      ]),
    );

    expect(rows).toEqual([['SKU'], ['A-1']]);
  });
});
