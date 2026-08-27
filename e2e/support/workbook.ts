import writeXlsxFile from 'write-excel-file/node';

/**
 * Build a real .xlsx in memory for the importer tests.
 *
 * A checked-in binary fixture would be untouchable: nobody can read an .xlsx in
 * a diff, so a test depending on one can only be understood by opening Excel.
 * Generating it from an array of arrays puts the sheet under test in the spec,
 * right next to the assertion about it.
 *
 * write-excel-file is by the same author as the read-excel-file the importer
 * parses with, so the fixture is written by the same reading of the format as
 * the code under test. Dev dependency only — nothing here ships.
 */
export const xlsxBuffer = async (rows: readonly (readonly string[])[]): Promise<Buffer> => {
  // Every cell is written as a STRING, matching what the reader hands the
  // planner. Letting the writer infer a number type would make the fixture
  // disagree with production sheets, where a price arrives as text.
  const data = rows.map((row) => row.map((value) => ({ type: String, value })));
  return await writeXlsxFile(data).toBuffer();
};

/** A Playwright file payload for setInputFiles. */
export const xlsxUpload = async (
  name: string,
  rows: readonly (readonly string[])[],
): Promise<{ name: string; mimeType: string; buffer: Buffer }> => ({
  name,
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  buffer: await xlsxBuffer(rows),
});
