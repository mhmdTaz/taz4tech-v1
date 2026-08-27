/**
 * Use case: import a catalogue spreadsheet.
 *
 * Two modes, one code path. A dry run produces exactly the plan a commit would
 * apply — same parsing, same grouping, same validation — so the preview an
 * operator approves is the thing that happens, not a rehearsal of it.
 *
 * `commit: false` is the DEFAULT. An import that writes because a flag was
 * forgotten is the failure this feature exists to prevent.
 */

import type { EntityId } from '@platform/ids';
import { err, ok, type Result } from '@platform/result';
import type { ProductRepository, WorkbookReader } from '../contracts';
import type { Product } from '../domain/product';
import { type ColumnMapping, detectMapping } from './import/column-mapping';
import { type ImportPlan, planImport } from './import/plan-import';

export type ImportProductsError =
  | { readonly tag: 'file_unreadable'; readonly reason: string }
  | { readonly tag: 'sheet_empty' };

export type ImportProductsInput = {
  readonly file: Uint8Array;
  /** Omit to auto-detect from the header row; the operator confirms before committing. */
  readonly mapping?: ColumnMapping;
  /** Nothing is written unless this is explicitly true. */
  readonly commit?: boolean;
};

export type ImportProductsOutput = {
  readonly headers: readonly string[];
  /** The mapping actually used, so the UI can show and edit it. */
  readonly mapping: ColumnMapping;
  readonly plan: ImportPlan;
  /** Products written. Always 0 for a dry run. */
  readonly written: number;
  readonly committed: boolean;
};

export type ImportProducts = (
  input: ImportProductsInput,
) => Promise<Result<ImportProductsOutput, ImportProductsError>>;

export const makeImportProducts =
  (deps: {
    repository: ProductRepository;
    reader: WorkbookReader;
    storeId: string;
    now: () => Date;
    nextId: () => EntityId<'Product'>;
  }): ImportProducts =>
  async (input) => {
    let rows: string[][];
    try {
      rows = await deps.reader.readRows(input.file);
    } catch (error) {
      // A corrupt upload is an expected outcome of accepting files from a
      // browser, not a bug — so it is an Err the UI can render, not a 500.
      return err({
        tag: 'file_unreadable',
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }

    const [headers] = rows;
    if (headers === undefined || headers.length === 0) return err({ tag: 'sheet_empty' });

    const mapping = input.mapping ?? detectMapping(headers);

    /*
     * Resolve create-vs-update in ONE query.
     *
     * The slugs are computed by planning against an empty map first, then the
     * real lookup is fed into a second pass. Two cheap in-memory passes beat
     * four hundred round trips to Atlas, and the alternative — asking the
     * planner to do IO — would cost it the purity that makes it testable.
     */
    const provisional = planImport({
      rows,
      mapping,
      storeId: deps.storeId,
      now: deps.now(),
      existingBySlug: new Map(),
      nextId: deps.nextId,
    });

    const slugs = [
      ...new Set([
        ...provisional.products.map((planned) => planned.product.slug),
        ...provisional.productProblems.map((problem) => problem.slug),
      ]),
    ];

    const existing =
      slugs.length === 0 ? [] : await deps.repository.findBySlugs(deps.storeId, slugs);
    const existingBySlug = new Map<string, Product>(
      existing.map((product) => [product.slug, product]),
    );

    const plan = planImport({
      rows,
      mapping,
      storeId: deps.storeId,
      now: deps.now(),
      existingBySlug,
      nextId: deps.nextId,
    });

    if (input.commit !== true) {
      return ok({ headers, mapping, plan, written: 0, committed: false });
    }

    /*
     * Only the valid products are written. A sheet with three bad rows out of
     * four hundred should import three hundred and ninety seven, not nothing —
     * the operator fixes three rows and re-imports, rather than hunting for the
     * one cell that blocked everything.
     */
    let written = 0;
    for (const planned of plan.products) {
      await deps.repository.save(planned.product);
      written++;
    }

    return ok({ headers, mapping, plan, written, committed: true });
  };
