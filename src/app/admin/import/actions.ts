'use server';

import {
  type ColumnMapping,
  IMPORT_FIELDS,
  type ImportField,
  type ImportReport,
  toImportReport,
} from '@modules/catalog';
import { notFound } from 'next/navigation';
import { getContainer } from '@/composition';
import { requireAdmin } from '../session';

/**
 * The two things the import screen can ask for: show me what would happen, and
 * do it. They are one function with a boolean, because the point of the dry run
 * is that it is the SAME code path — a preview produced by a second, simpler
 * implementation would eventually disagree with the thing it previews.
 */

export type ImportResponse =
  | { readonly ok: true; readonly report: ImportReport }
  | { readonly ok: false; readonly message: string };

/**
 * A ceiling on the upload.
 *
 * A real 400-product price list is a few hundred kilobytes. This is generous
 * enough that no genuine catalogue hits it and small enough that a hostile
 * upload cannot exhaust the 512 MB Render instance. Enforced HERE as well as in
 * next.config's bodySizeLimit, because that limit protects the process while
 * this one produces a sentence the operator can read.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Sheets wider than this are not sheets. Bounds the mapping indices we accept. */
const MAX_COLUMNS = 512;

const isImportField = (value: string): value is ImportField =>
  (IMPORT_FIELDS as readonly string[]).includes(value);

/**
 * Parse the mapping the operator chose.
 *
 * Returns null on anything unexpected, and the caller turns that into a REFUSAL
 * rather than a fallback to auto-detection. Silently re-detecting would import
 * with a mapping the operator did not pick — which is precisely how a "Cost"
 * column ends up loaded as the selling price.
 */
const parseMapping = (raw: string): ColumnMapping | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const mapping: ColumnMapping = {};
  for (const [field, index] of Object.entries(parsed)) {
    if (!isImportField(field)) return null;
    if (typeof index !== 'number' || !Number.isInteger(index)) return null;
    if (index < 0 || index >= MAX_COLUMNS) return null;
    mapping[field] = index;
  }
  return mapping;
};

const run = async (formData: FormData, commit: boolean): Promise<ImportResponse> => {
  await requireAdmin();

  const container = await getContainer();
  // The flag is the kill switch: turning it off takes the screen away without a
  // deploy, which is the whole reason a finished feature still has a flag.
  if (!container.flags.isOn('excelImporter')) notFound();

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose an .xlsx file first.' };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    const megabytes = (file.size / (1024 * 1024)).toFixed(1);
    return { ok: false, message: `That file is ${megabytes} MB. The limit is 5 MB.` };
  }
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    // .xls and .csv are different formats wearing similar names; the reader would
    // fail on them anyway, but saying so up front beats "file unreadable".
    return { ok: false, message: 'Only .xlsx files can be imported — not .xls or .csv.' };
  }

  const rawMapping = formData.get('mapping');
  let mapping: ColumnMapping | undefined;
  if (typeof rawMapping === 'string' && rawMapping.length > 0) {
    const parsed = parseMapping(rawMapping);
    if (parsed === null) return { ok: false, message: 'That column mapping is not valid.' };
    mapping = parsed;
  }

  const result = await container.catalog.importProducts({
    file: new Uint8Array(await file.arrayBuffer()),
    ...(mapping === undefined ? {} : { mapping }),
    commit,
  });

  if (!result.ok) {
    if (result.error.tag === 'sheet_empty') {
      return { ok: false, message: 'That sheet has no header row.' };
    }
    container.logger.warn('admin import could not read the uploaded file', {
      reason: result.error.reason,
    });
    // The reader's own message can name internal paths; the operator gets the
    // actionable version and the detail goes to the log.
    return { ok: false, message: 'That file could not be read as an .xlsx workbook.' };
  }

  const { headers, rows, plan, written, failures, committed } = result.value;

  if (committed) {
    container.logger.info('catalogue imported from the admin screen', {
      written,
      products: plan.summary.products,
      rowsRejected: plan.summary.rowsRejected,
      skuConflicts: plan.skuConflicts.length,
      // Non-zero means a write raced with another one. Worth a line in the log
      // even though the operator is also told on screen.
      failures: failures.length,
    });
  }

  return {
    ok: true,
    report: toImportReport({
      headers,
      rows,
      mapping: result.value.mapping,
      plan,
      committed,
      written,
      failures,
    }),
  };
};

export const analyseImport = async (formData: FormData): Promise<ImportResponse> =>
  run(formData, false);

export const commitImport = async (formData: FormData): Promise<ImportResponse> =>
  run(formData, true);
