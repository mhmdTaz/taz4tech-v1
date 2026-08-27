/**
 * The import plan, flattened into something that can cross a wire.
 *
 * An ImportPlan holds real Product aggregates — Money objects, Date objects,
 * every variant and every spec. The admin screen needs none of that; it needs
 * roughly twelve fields per product and the problems, and it needs them as JSON.
 *
 * WHY THIS IS NOT DONE IN THE PAGE
 * --------------------------------
 * A React Server Component that serialised the plan itself would put Product,
 * Money and the domain's error union into the client boundary, and any of them
 * changing shape would silently change what the browser receives. Doing it here,
 * in a pure function under the 100% gate, makes the wire format an explicit,
 * tested contract instead of an accident of what happened to be serialisable.
 *
 * Money stays in integer cents and nothing is formatted here: formatting needs a
 * locale, and the plan has no opinion about who is reading it.
 */

import type { Locale } from '@platform/locale';
import type { Currency } from '@platform/money';
import { type ProductError, type ProductStatus, priceRange } from '../../domain/product';
import type { ColumnMapping, ImportField, MappingProblem } from './column-mapping';
import type { CellProblem } from './parse-cell';
import type { ImportPlan, SkuConflict } from './plan-import';
import type { ImageFailure } from './take-images';

export type ProductPreview = {
  readonly slug: string;
  readonly title: string;
  readonly action: 'create' | 'update';
  /** Excel row numbers this product was assembled from. */
  readonly rows: readonly number[];
  readonly brand: string | null;
  readonly status: ProductStatus;
  readonly variantCount: number;
  /** Integer cents, cheapest and dearest variant. Equal when there is one price. */
  readonly priceFromCents: number;
  readonly priceToCents: number;
  readonly currency: Currency;
  readonly imageCount: number;
  /** Stock levels this row set, per SKU. Empty when the sheet said nothing. */
  readonly stock: readonly { readonly sku: string; readonly onHand: number }[];
  /** Locales with a title, so the operator can see what still needs translating. */
  readonly translatedInto: readonly Locale[];
};

export type RowProblemView = {
  readonly row: number;
  readonly field: ImportField;
  readonly problem: CellProblem;
};

export type ProductProblemView = {
  readonly rows: readonly number[];
  readonly slug: string;
  readonly reason: ProductError;
};

export type ImportReport = {
  readonly headers: readonly string[];
  /** First few data rows verbatim, so a column can be identified by its contents. */
  readonly sampleRows: readonly (readonly string[])[];
  readonly mapping: ColumnMapping;
  readonly mappingProblems: readonly MappingProblem[];
  readonly products: readonly ProductPreview[];
  readonly rowProblems: readonly RowProblemView[];
  readonly productProblems: readonly ProductProblemView[];
  /** SKUs the sheet claims that already belong to a different product. */
  readonly skuConflicts: readonly SkuConflict[];
  /** Only ever non-empty after a commit that raced with another write. */
  readonly failures: readonly { readonly slug: string; readonly reason: string }[];
  /** SKUs whose stock the sheet stated and the write refused. */
  readonly stockFailures: readonly { readonly sku: string; readonly reason: string }[];
  readonly stockWritten: number;
  /**
   * Images the shop could not take its own copy of.
   *
   * The product imported without that picture — a supplier CDN having a bad
   * afternoon must not cost four hundred products — so this is the receipt's
   * job: say which ones, and why, so the sheet can be fixed and re-imported.
   */
  readonly imageFailures: readonly ImageFailure[];
  /** Distinct supplier images fetched and stored. Zero on a preview, always. */
  readonly imagesTaken: number;
  readonly summary: ImportPlan['summary'];
  /** True once a commit has happened; the preview and the receipt share this shape. */
  readonly committed: boolean;
  readonly written: number;
};

export type SaveFailure = {
  readonly slug: string;
  readonly conflict: { readonly tag: 'sku_taken' | 'slug_taken' } & Record<string, unknown>;
};

/** How many data rows to show as a sample. Enough to recognise a column, not a paste of the sheet. */
export const SAMPLE_ROW_COUNT = 5;

const LOCALES: readonly Locale[] = ['en', 'ar', 'fr'];

export type ToImportReportInput = {
  readonly headers: readonly string[];
  /** Every row including the header, as read from the sheet. */
  readonly rows: readonly (readonly string[])[];
  readonly mapping: ColumnMapping;
  readonly plan: ImportPlan;
  readonly committed: boolean;
  readonly written: number;
  readonly failures: readonly SaveFailure[];
  readonly stockFailures: readonly { readonly sku: string; readonly reason: string }[];
  readonly stockWritten: number;
  readonly imageFailures: readonly ImageFailure[];
  readonly imagesTaken: number;
};

export const toImportReport = (input: ToImportReportInput): ImportReport => {
  const [, ...dataRows] = input.rows;

  const products = input.plan.products.map(({ product, action, rows, stock }): ProductPreview => {
    // The domain's own helper, which folds with reduce and no seed — so "at
    // least one variant" is carried by the type rather than by a length check
    // that could never be false and would sit uncovered under the 100% gate.
    const { from, to } = priceRange(product);

    return {
      slug: product.slug,
      title: product.title.en,
      action,
      rows,
      brand: product.brand,
      status: product.status,
      variantCount: product.variants.length,
      priceFromCents: from.cents,
      priceToCents: to.cents,
      currency: from.currency,
      imageCount: product.media.length,
      stock,
      translatedInto: LOCALES.filter((locale) => product.title[locale] !== undefined),
    };
  });

  return {
    headers: input.headers,
    sampleRows: dataRows.slice(0, SAMPLE_ROW_COUNT),
    mapping: input.mapping,
    mappingProblems: input.plan.mappingProblems,
    products,
    rowProblems: input.plan.rowProblems,
    productProblems: input.plan.productProblems,
    skuConflicts: input.plan.skuConflicts,
    failures: input.failures.map((failure) => ({
      slug: failure.slug,
      reason:
        failure.conflict.tag === 'sku_taken'
          ? `the SKU ${String(failure.conflict.sku)} was taken while this import was running`
          : `the URL slug ${String(failure.conflict.slug)} was taken while this import was running`,
    })),
    summary: input.plan.summary,
    committed: input.committed,
    written: input.written,
    stockFailures: input.stockFailures,
    stockWritten: input.stockWritten,
    imageFailures: input.imageFailures,
    imagesTaken: input.imagesTaken,
  };
};
