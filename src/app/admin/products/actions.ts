'use server';

import {
  type BulkEditReport,
  type BulkOperation,
  isValidBasisPoints,
  MAX_BULK_SELECTION,
  PRODUCT_STATUSES,
  type ProductId,
  type ProductStatus,
  toBulkEditReport,
} from '@modules/catalog';
import { notFound } from 'next/navigation';
import { getContainer } from '@/composition';
import { requireAdmin } from '../session';

/**
 * Preview a bulk edit, and apply one.
 *
 * One function with a boolean, for the same reason the importer has one: a
 * preview produced by a second implementation eventually disagrees with the
 * thing it previews.
 */

export type BulkResponse =
  | { readonly ok: true; readonly report: BulkEditReport }
  | { readonly ok: false; readonly message: string };

/** A product id is a ULID-shaped string; anything else is not from our UI. */
const ID_PATTERN = /^[0-9A-Z]{20,32}$/;

const isProductStatus = (value: string): value is ProductStatus =>
  (PRODUCT_STATUSES as readonly string[]).includes(value);

/**
 * Read the operation out of the form.
 *
 * Returns a message rather than a partial operation: an unreadable form means
 * the request did not come from this screen, and guessing what was meant is how
 * a price change becomes a status change.
 */
const readOperation = (formData: FormData): BulkOperation | string => {
  const kind = formData.get('operation');

  if (kind === 'set_status') {
    const status = formData.get('status');
    if (typeof status !== 'string' || !isProductStatus(status)) return 'Pick a status.';
    return { tag: 'set_status', status };
  }

  if (kind === 'set_brand') {
    const brand = formData.get('brand');
    if (typeof brand !== 'string') return 'Enter a brand, or leave it empty to clear it.';
    // Empty means "clear the brand" — an explicit choice the UI offers, not a
    // missing field. The domain does the trimming.
    return { tag: 'set_brand', brand: brand.trim().length === 0 ? null : brand };
  }

  if (kind === 'scale_price') {
    const raw = formData.get('basisPoints');
    const basisPoints = typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!isValidBasisPoints(basisPoints)) return 'That price change is out of range.';
    return { tag: 'scale_price', basisPoints };
  }

  if (kind === 'clear_offer') return { tag: 'clear_offer' };

  return 'Pick something to change.';
};

const readIds = (formData: FormData): ProductId[] | string => {
  const raw = formData.getAll('productId');
  const ids: ProductId[] = [];

  for (const value of raw) {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) return 'That selection is not valid.';
    ids.push(value as ProductId);
  }

  if (ids.length === 0) return 'Select at least one product.';
  // Checked here as well as in the use case: this message names the limit, and
  // the use case guarantees it regardless of who calls.
  if (ids.length > MAX_BULK_SELECTION) {
    return `Select at most ${MAX_BULK_SELECTION} products at a time.`;
  }

  return ids;
};

const run = async (formData: FormData, commit: boolean): Promise<BulkResponse> => {
  await requireAdmin();

  const container = await getContainer();
  if (!container.flags.isOn('excelImporter')) notFound();

  const ids = readIds(formData);
  if (typeof ids === 'string') return { ok: false, message: ids };

  const operation = readOperation(formData);
  if (typeof operation === 'string') return { ok: false, message: operation };

  const result = await container.catalog.bulkEdit({ productIds: ids, operation, commit });

  if (!result.ok) {
    if (result.error.tag === 'too_many_selected') {
      return { ok: false, message: `Select at most ${result.error.limit} products at a time.` };
    }
    if (result.error.tag === 'invalid_basis_points') {
      return { ok: false, message: 'That price change is out of range.' };
    }
    return { ok: false, message: 'Select at least one product.' };
  }

  if (commit) {
    container.logger.info('bulk edit applied from the admin screen', {
      operation: result.value.operation.tag,
      selected: ids.length,
      written: result.value.written,
      refused: result.value.refusals.length,
      failures: result.value.failures.length,
    });
  }

  return { ok: true, report: toBulkEditReport(result.value) };
};

export const previewBulkEdit = async (formData: FormData): Promise<BulkResponse> =>
  run(formData, false);

export const applyBulkEdit = async (formData: FormData): Promise<BulkResponse> =>
  run(formData, true);
