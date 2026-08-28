/**
 * Turning mapped spreadsheet rows into a reviewable import plan.
 *
 * Pure: rows in, plan out. No database, no file format, no clock of its own —
 * which is what lets the awkward cases be tested as plain arrays rather than as
 * fixture .xlsx files nobody can read in a diff.
 *
 * ONE PRODUCT, MANY ROWS
 * ----------------------
 * Real catalogue sheets put one VARIANT per row: three rows of "Lenovo IdeaPad"
 * differing only by colour are one product with three variants, not three
 * products. Rows are grouped by slug — explicit if the sheet has one, derived
 * from the English title otherwise.
 *
 * The plan is the dry run. Nothing here writes anything; the caller decides
 * whether to commit it after a human has looked.
 */

import type { EntityId } from '@platform/ids';
import type { LocalizedText } from '@platform/locale';
import type { Money } from '@platform/money';
import {
  createProduct,
  type Media,
  type Product,
  type ProductError,
  type ProductStatus,
  slugify,
  type Variant,
  type VariantOption,
} from '../../domain/product';
import type { ColumnMapping, ImportField } from './column-mapping';
import { validateMapping } from './column-mapping';
import type { CellProblem } from './parse-cell';
import * as cell from './parse-cell';

export type RowProblem = {
  /** 1-based row number AS SHOWN IN EXCEL, so it can be read back to the operator. */
  readonly row: number;
  readonly field: ImportField;
  readonly problem: CellProblem;
};

export type ProductProblem = {
  readonly rows: readonly number[];
  readonly slug: string;
  readonly reason: ProductError;
};

/**
 * A SKU in the sheet already belongs to a DIFFERENT product in the catalogue.
 *
 * Kept apart from ProductProblem because it is a different kind of wrong: the
 * product the sheet describes is perfectly valid, it just cannot be written
 * without taking a SKU from something else. The fix is also different — edit the
 * catalogue, or correct the SKU — so it reads better as its own list than as one
 * more entry in a column of validation failures.
 *
 * Detecting it here rather than letting the unique index do it is the whole
 * point: the index answers with E11000 halfway through the write, after some
 * products have already been saved.
 */
export type SkuConflict = {
  readonly rows: readonly number[];
  /** The slug the sheet is trying to create or update. */
  readonly slug: string;
  readonly sku: string;
  /** The product that already owns the SKU. */
  readonly ownedBySlug: string;
};

export type PlannedProduct = {
  readonly product: Product;
  readonly action: 'create' | 'update';
  /** Excel row numbers this product came from, for the preview table. */
  readonly rows: readonly number[];
  /**
   * Stock the sheet stated, per SKU. Empty when it said nothing.
   *
   * A blank cell is NOT zero. "I did not count this" and "there are none" are
   * different claims, and importing the first as the second would take a
   * catalogue off sale on the strength of an empty column.
   */
  readonly stock: readonly { readonly sku: string; readonly onHand: number }[];
};

export type ImportPlan = {
  readonly products: readonly PlannedProduct[];
  readonly rowProblems: readonly RowProblem[];
  readonly productProblems: readonly ProductProblem[];
  readonly skuConflicts: readonly SkuConflict[];
  readonly mappingProblems: readonly { tag: 'missing_required_field'; field: ImportField }[];
  readonly summary: {
    readonly dataRows: number;
    readonly products: number;
    readonly toCreate: number;
    readonly toUpdate: number;
    readonly rowsRejected: number;
  };
};

export type PlanImportInput = {
  /** Every row INCLUDING the header row, exactly as read from the sheet. */
  readonly rows: readonly (readonly string[])[];
  readonly mapping: ColumnMapping;
  readonly storeId: string;
  readonly now: Date;
  /** Slug -> existing product, so the plan can say create vs update. */
  readonly existingBySlug: ReadonlyMap<string, Product>;
  /**
   * SKU -> the slug of the product that already owns it.
   *
   * Empty on the first, provisional pass — that pass exists only to work out
   * which slugs and SKUs to look up.
   */
  readonly ownerSlugBySku: ReadonlyMap<string, string>;
  /** Ids for products being created. */
  readonly nextId: () => EntityId<'Product'>;
};

/** The header row is row 1 in Excel, so data row i (0-based) is Excel row i + 2. */
const excelRow = (dataIndex: number): number => dataIndex + 2;

const localized = (en: string, ar: string | null, fr: string | null): LocalizedText => {
  const text: { en: string; ar?: string; fr?: string } = { en };
  if (ar !== null) text.ar = ar;
  if (fr !== null) text.fr = fr;
  return text;
};

type ParsedRow = {
  readonly rowNumber: number;
  readonly slug: string;
  readonly titleEn: string;
  readonly titleAr: string | null;
  readonly titleFr: string | null;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly descriptionFr: string | null;
  readonly brand: string | null;
  readonly status: ProductStatus;
  readonly sku: string;
  readonly price: Money;
  readonly compareAtPrice: Money | null;
  readonly offerEndsAt: Date | null;
  readonly barcode: string | null;
  readonly weightGrams: number | null;
  readonly options: readonly VariantOption[];
  readonly image: Media | null;
  /** null when the sheet has no stock column, or the cell is blank for this row. */
  readonly stock: number | null;
};

/** Read one data row. Returns every problem it finds, not only the first. */
const parseRow = (
  values: readonly string[],
  mapping: ColumnMapping,
  rowNumber: number,
  now: Date,
): { row: ParsedRow | null; problems: RowProblem[] } => {
  const problems: RowProblem[] = [];
  const at = (field: ImportField): string | undefined => {
    const index = mapping[field];
    return index === undefined ? undefined : values[index];
  };

  const record = <T>(field: ImportField, result: cell.CellResult<T>): T | null => {
    if (result.ok) return result.value;
    problems.push({ row: rowNumber, field, problem: result.error });
    return null;
  };

  const titleEn = record('titleEn', cell.requiredText(at('titleEn')));
  const sku = record('sku', cell.requiredText(at('sku')));
  const price = record('price', cell.money(at('price')));
  const compareAtPrice = record('compareAtPrice', cell.optionalMoney(at('compareAtPrice')));
  const offerEndsAt = record('offerEndsAt', cell.optionalDate(at('offerEndsAt')));

  /*
   * A date that has already passed is reported, not refused.
   *
   * The domain CLEARS an expired offer rather than rejecting the product, which
   * is what stopped a month-old promotion making a product unwritable. That
   * makes this the only place a typo can still be caught — 2025 where 2026 was
   * meant — because here the row number is known and the operator is looking at
   * the sheet. The row still imports; it just imports without the offer, and
   * says so.
   */
  if (offerEndsAt !== null && offerEndsAt.getTime() <= now.getTime()) {
    problems.push({
      row: rowNumber,
      field: 'offerEndsAt',
      problem: { tag: 'date_already_past', value: cell.text(at('offerEndsAt')) },
    });
  }
  const productStatus = record('status', cell.status(at('status')));
  const weightGrams = record('weightGrams', cell.optionalInteger(at('weightGrams')));
  const stock = record('stock', cell.optionalInteger(at('stock')));

  if (titleEn === null || sku === null || price === null || productStatus === null) {
    return { row: null, problems };
  }

  const explicitSlug = cell.optionalText(at('slug'));
  const slug = explicitSlug === null ? slugify(titleEn) : slugify(explicitSlug);

  const options: VariantOption[] = [];
  for (const [nameField, valueField] of [
    ['option1Name', 'option1Value'],
    ['option2Name', 'option2Value'],
  ] as const) {
    const name = cell.optionalText(at(nameField));
    const value = cell.optionalText(at(valueField));
    // An option needs both halves. A name with no value is a column the sheet
    // declares but this row does not use, which is normal in mixed catalogues.
    if (name !== null && value !== null) options.push({ name, value });
  }

  const imageUrl = cell.optionalText(at('imageUrl'));
  const imageAlt = cell.optionalText(at('imageAlt'));

  return {
    row: {
      rowNumber,
      slug,
      titleEn,
      titleAr: cell.optionalText(at('titleAr')),
      titleFr: cell.optionalText(at('titleFr')),
      descriptionEn: cell.optionalText(at('descriptionEn')),
      descriptionAr: cell.optionalText(at('descriptionAr')),
      descriptionFr: cell.optionalText(at('descriptionFr')),
      brand: cell.optionalText(at('brand')),
      status: productStatus,
      sku,
      price,
      compareAtPrice,
      offerEndsAt,
      barcode: cell.optionalText(at('barcode')),
      weightGrams,
      stock,
      options,
      image:
        imageUrl === null
          ? null
          : {
              kind: 'image',
              url: imageUrl,
              // Alt text is required by the domain. Falling back to the title is
              // better than blocking the import, and far better than an empty
              // alt, which is a WCAG failure the product page would inherit.
              alt: { en: imageAlt ?? titleEn },
              width: null,
              height: null,
            },
    },
    problems,
  };
};

const toVariant = (row: ParsedRow): Variant => ({
  sku: row.sku,
  options: row.options,
  price: row.price,
  compareAtPrice: row.compareAtPrice,
  offerEndsAt: row.offerEndsAt,
  barcode: row.barcode,
  weightGrams: row.weightGrams,
});

/**
 * Assemble one product from the rows that share its slug.
 *
 * Product-level fields come from the FIRST row of the group. A sheet that
 * repeats the title on every variant row agrees with itself; one that disagrees
 * has a data problem the operator should see in the preview rather than have
 * silently resolved by last-write-wins.
 */
const assembleProduct = (
  // A non-empty tuple, not an array: the caller only ever builds groups with at
  // least one row, and saying so in the TYPE removes the runtime guard that
  // noUncheckedIndexedAccess would otherwise demand — a branch that can never
  // fire, sitting inside a layer gated at 100% coverage.
  rows: readonly [ParsedRow, ...ParsedRow[]],
  input: PlanImportInput,
): { product: Product; action: 'create' | 'update' } | { error: ProductProblem } => {
  const [first] = rows;

  const existing = input.existingBySlug.get(first.slug);
  const optionNames = first.options.map((option) => option.name);

  const media: Media[] = [];
  for (const row of rows) {
    if (row.image !== null && !media.some((item) => item.url === row.image?.url)) {
      media.push(row.image);
    }
  }

  const candidate: Product = {
    storeId: input.storeId,
    // Keep the existing id on update, so a re-import edits the product rather
    // than colliding with it on the unique slug index.
    id: existing?.id ?? input.nextId(),
    slug: first.slug,
    title: localized(first.titleEn, first.titleAr, first.titleFr),
    description: localized(
      first.descriptionEn ?? first.titleEn,
      first.descriptionAr,
      first.descriptionFr,
    ),
    brand: first.brand,
    status: first.status,
    optionNames,
    variants: rows.map(toVariant),
    media,
    specs: existing?.specs ?? [],
    createdAt: existing?.createdAt ?? input.now,
    updatedAt: input.now,
  };

  const product = createProduct(candidate, input.now);
  if (!product.ok) {
    return {
      error: {
        rows: rows.map((row) => row.rowNumber),
        slug: first.slug,
        reason: product.error,
      },
    };
  }

  return { product: product.value, action: existing === undefined ? 'create' : 'update' };
};

/**
 * The first SKU on this product that already belongs to something else.
 *
 * A SKU owned by the SAME slug is not a conflict — that is an update, which is
 * the normal case for a re-imported price list.
 */
const findStolenSku = (
  product: Product,
  ownerSlugBySku: ReadonlyMap<string, string>,
): { sku: string; ownedBySlug: string } | null => {
  for (const variant of product.variants) {
    const ownedBySlug = ownerSlugBySku.get(variant.sku);
    if (ownedBySlug !== undefined && ownedBySlug !== product.slug) {
      return { sku: variant.sku, ownedBySlug };
    }
  }
  return null;
};

type Assembled = {
  products: PlannedProduct[];
  productProblems: ProductProblem[];
  skuConflicts: SkuConflict[];
};

/** Turn the slug groups into products, sorting each into the list it belongs in. */
const assembleGroups = (
  groups: ReadonlyMap<string, readonly [ParsedRow, ...ParsedRow[]]>,
  input: PlanImportInput,
): Assembled => {
  const result: Assembled = { products: [], productProblems: [], skuConflicts: [] };

  for (const rows of groups.values()) {
    const assembled = assembleProduct(rows, input);
    if ('error' in assembled) {
      result.productProblems.push(assembled.error);
      continue;
    }

    const rowNumbers = rows.map((row) => row.rowNumber);
    const stolen = findStolenSku(assembled.product, input.ownerSlugBySku);
    if (stolen !== null) {
      result.skuConflicts.push({ rows: rowNumbers, slug: assembled.product.slug, ...stolen });
      continue;
    }

    result.products.push({
      product: assembled.product,
      action: assembled.action,
      rows: rowNumbers,
      /*
       * A blank cell is NOT zero. "I did not count this" and "there are none"
       * are different claims, and importing the first as the second would take a
       * catalogue off sale on the strength of an empty column.
       */
      stock: rows
        .filter((row): row is ParsedRow & { stock: number } => row.stock !== null)
        .map((row) => ({ sku: row.sku, onHand: row.stock })),
    });
  }

  return result;
};

export const planImport = (input: PlanImportInput): ImportPlan => {
  const mappingProblems = validateMapping(input.mapping);
  const [, ...dataRows] = input.rows;

  if (mappingProblems.length > 0) {
    return {
      products: [],
      rowProblems: [],
      productProblems: [],
      skuConflicts: [],
      mappingProblems,
      summary: {
        dataRows: dataRows.length,
        products: 0,
        toCreate: 0,
        toUpdate: 0,
        rowsRejected: dataRows.length,
      },
    };
  }

  const rowProblems: RowProblem[] = [];
  const parsed: ParsedRow[] = [];
  const seenSkus = new Map<string, number>();

  dataRows.forEach((values, index) => {
    const rowNumber = excelRow(index);
    // A wholly empty row is spreadsheet punctuation, not an error.
    if (values.every((value) => cell.isBlank(value))) return;

    const result = parseRow(values, input.mapping, rowNumber, input.now);
    rowProblems.push(...result.problems);
    if (result.row === null) return;

    const firstSeenAt = seenSkus.get(result.row.sku);
    if (firstSeenAt !== undefined) {
      // Two rows claiming one SKU cannot both be right, and the unique index
      // would reject the whole import at the very end. Better to say which rows.
      rowProblems.push({
        row: rowNumber,
        field: 'sku',
        problem: { tag: 'duplicate_sku', firstSeenAtRow: firstSeenAt },
      });
      return;
    }
    seenSkus.set(result.row.sku, rowNumber);
    parsed.push(result.row);
  });

  const groups = new Map<string, [ParsedRow, ...ParsedRow[]]>();
  for (const row of parsed) {
    const group = groups.get(row.slug);
    if (group === undefined) groups.set(row.slug, [row]);
    else group.push(row);
  }

  const { products, productProblems, skuConflicts } = assembleGroups(groups, input);

  const rejectedRows = new Set<number>(rowProblems.map((problem) => problem.row));
  for (const problem of productProblems) for (const row of problem.rows) rejectedRows.add(row);
  for (const conflict of skuConflicts) for (const row of conflict.rows) rejectedRows.add(row);

  return {
    products,
    rowProblems,
    productProblems,
    skuConflicts,
    mappingProblems,
    summary: {
      dataRows: dataRows.length,
      products: products.length,
      toCreate: products.filter((planned) => planned.action === 'create').length,
      toUpdate: products.filter((planned) => planned.action === 'update').length,
      rowsRejected: rejectedRows.size,
    },
  };
};
