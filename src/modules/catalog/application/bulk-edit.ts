/**
 * Use case: apply one operation to an explicitly chosen set of products.
 *
 * Same two-mode shape as the importer, for the same reason. `commit: false` is
 * the DEFAULT, and the preview is produced by exactly the code a commit runs —
 * so what the operator approves is what happens, rather than a second, simpler
 * implementation's guess at it.
 *
 * EXPLICIT IDS, NEVER "EVERYTHING MATCHING THIS FILTER"
 * ----------------------------------------------------
 * The selection is a list of product ids the caller already has on screen. A
 * server-side "apply to all 400 results" would be one mistyped filter away from
 * repricing the whole catalogue, and the operator would have approved a count
 * rather than a list. Wholesale change is what the importer is for; this is for
 * the forty products someone is looking at.
 */

import { err, ok, type Result } from '@platform/result';
import type { ProductRepository, SaveConflict } from '../contracts';
import {
  applyBulkOperation,
  type BulkOperation,
  type BulkRefusal,
  isValidBasisPoints,
} from '../domain/bulk-edit';
import { type Product, type ProductId, priceRange } from '../domain/product';

/**
 * One screenful and a bit.
 *
 * Chosen to be larger than a page of results (60) so a selection carried across
 * a page boundary still works, and small enough that the whole set fits in the
 * preview the operator is expected to actually read.
 */
export const MAX_BULK_SELECTION = 100;

export type BulkEditError =
  | { readonly tag: 'nothing_selected' }
  | { readonly tag: 'too_many_selected'; readonly count: number; readonly limit: number }
  | { readonly tag: 'invalid_basis_points'; readonly value: number };

export type BulkEditInput = {
  readonly productIds: readonly ProductId[];
  readonly operation: BulkOperation;
  /** Nothing is written unless this is explicitly true. */
  readonly commit?: boolean;
};

export type BulkChange = {
  readonly before: Product;
  readonly after: Product;
};

export type BulkEditOutput = {
  readonly operation: BulkOperation;
  readonly changes: readonly BulkChange[];
  /** Selected, valid, and this operation does nothing to them. */
  readonly unchanged: readonly Product[];
  readonly refusals: readonly { readonly product: Product; readonly reason: BulkRefusal }[];
  /** Ids that matched nothing in this store — deleted, or from somewhere else. */
  readonly missing: readonly ProductId[];
  readonly written: number;
  readonly failures: readonly { readonly slug: string; readonly conflict: SaveConflict }[];
  readonly committed: boolean;
};

export type BulkEdit = (input: BulkEditInput) => Promise<Result<BulkEditOutput, BulkEditError>>;

/**
 * Bounds on the operation itself, before any product is touched.
 *
 * A multiplier of 1000000 basis points is a typo, not an intention, and the
 * difference between refusing it here and letting it through is a catalogue
 * priced at a hundred times its value with a preview nobody read closely enough.
 */
const validateOperation = (operation: BulkOperation): BulkEditError | null =>
  operation.tag === 'scale_price' && !isValidBasisPoints(operation.basisPoints)
    ? { tag: 'invalid_basis_points', value: operation.basisPoints }
    : null;

type Sorted = {
  readonly operation: BulkOperation;
  readonly changes: BulkChange[];
  readonly unchanged: Product[];
  readonly refusals: { product: Product; reason: BulkRefusal }[];
  readonly missing: ProductId[];
};

/**
 * Split the selection into the four things that can happen to a product.
 *
 * Iterates the SELECTION rather than what the database returned, so the order
 * the operator sees is the order they chose and a missing id keeps its place
 * instead of silently vanishing from the middle of the list.
 */
const sortOutcomes = (
  ids: readonly ProductId[],
  found: readonly Product[],
  operation: BulkOperation,
  now: Date,
): Sorted => {
  const byId = new Map(found.map((product) => [product.id, product]));
  const sorted: Sorted = { operation, changes: [], unchanged: [], refusals: [], missing: [] };

  for (const id of ids) {
    const product = byId.get(id);
    if (product === undefined) {
      sorted.missing.push(id);
      continue;
    }

    const outcome = applyBulkOperation(product, operation, now);
    if (outcome.tag === 'changed') sorted.changes.push({ before: product, after: outcome.product });
    else if (outcome.tag === 'unchanged') sorted.unchanged.push(product);
    else sorted.refusals.push({ product, reason: outcome.reason });
  }

  return sorted;
};

/**
 * Write every change, surviving a conflict on any one of them.
 *
 * Same rule as the importer: a uniqueness conflict costs one product and a line
 * in the receipt, never the rest of the batch. Anything that is NOT a conflict
 * still throws out of the repository, because a dropped connection must not be
 * reported as a partial success.
 */
const writeAll = async (
  repository: ProductRepository,
  changes: readonly BulkChange[],
): Promise<{ written: number; failures: { slug: string; conflict: SaveConflict }[] }> => {
  let written = 0;
  const failures: { slug: string; conflict: SaveConflict }[] = [];

  for (const change of changes) {
    const saved = await repository.save(change.after);
    if (saved.ok) written++;
    else failures.push({ slug: change.after.slug, conflict: saved.error });
  }

  return { written, failures };
};

export const makeBulkEdit =
  (deps: { repository: ProductRepository; storeId: string; now: () => Date }): BulkEdit =>
  async (input) => {
    // Duplicates in the selection would apply the operation twice and count it
    // twice; the second write is harmless but the number shown to the operator
    // would be wrong, which is not.
    const ids = [...new Set(input.productIds)];

    if (ids.length === 0) return err({ tag: 'nothing_selected' });
    if (ids.length > MAX_BULK_SELECTION) {
      return err({ tag: 'too_many_selected', count: ids.length, limit: MAX_BULK_SELECTION });
    }

    const operationProblem = validateOperation(input.operation);
    if (operationProblem !== null) return err(operationProblem);

    const found = await deps.repository.findByIds(deps.storeId, ids);
    const preview = sortOutcomes(ids, found, input.operation, deps.now());

    if (input.commit !== true) {
      return ok({ ...preview, written: 0, failures: [], committed: false });
    }

    return ok({
      ...preview,
      ...(await writeAll(deps.repository, preview.changes)),
      committed: true,
    });
  };

/** Everything the admin screen needs about one product, as JSON. */
export type BulkProductView = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: string;
  readonly brand: string | null;
  readonly priceFromCents: number;
  readonly priceToCents: number;
  readonly onOfferVariants: number;
};

export type BulkChangeView = {
  readonly before: BulkProductView;
  readonly after: BulkProductView;
};

export type BulkEditReport = {
  readonly operation: BulkOperation;
  readonly changes: readonly BulkChangeView[];
  readonly unchanged: readonly BulkProductView[];
  readonly refusals: readonly {
    readonly product: BulkProductView;
    readonly reason: BulkRefusal;
  }[];
  readonly missing: readonly string[];
  readonly written: number;
  readonly failures: readonly { readonly slug: string; readonly reason: string }[];
  readonly committed: boolean;
};

const view = (product: Product): BulkProductView => {
  // The domain's own fold, rather than a second one here. It carries "at least
  // one variant" in the type instead of in a length check that can never be
  // false, and it is already exercised by the storefront.
  const { from, to } = priceRange(product);

  return {
    id: product.id,
    slug: product.slug,
    title: product.title.en,
    status: product.status,
    brand: product.brand,
    priceFromCents: from.cents,
    priceToCents: to.cents,
    onOfferVariants: product.variants.filter((variant) => variant.compareAtPrice !== null).length,
  };
};

/**
 * The plan, flattened into something that can cross a wire.
 *
 * Exactly the reasoning behind the importer's report: serialising Product,
 * Money and the domain's error union straight into a client boundary makes the
 * wire format an accident of what happened to be serialisable, and a shape
 * change silently changes what the browser receives.
 */
export const toBulkEditReport = (output: BulkEditOutput): BulkEditReport => ({
  operation: output.operation,
  changes: output.changes.map((change) => ({
    before: view(change.before),
    after: view(change.after),
  })),
  unchanged: output.unchanged.map(view),
  refusals: output.refusals.map((refusal) => ({
    product: view(refusal.product),
    reason: refusal.reason,
  })),
  missing: [...output.missing],
  written: output.written,
  failures: output.failures.map((failure) => ({
    slug: failure.slug,
    reason:
      failure.conflict.tag === 'sku_taken'
        ? `the SKU ${failure.conflict.sku} was taken while this edit was running`
        : `the URL slug ${failure.conflict.slug} was taken while this edit was running`,
  })),
  committed: output.committed,
});
