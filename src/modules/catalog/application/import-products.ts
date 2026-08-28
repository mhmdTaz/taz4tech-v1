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
import type {
  ImageIngestor,
  ProductRepository,
  SaveConflict,
  StockWriteFailure,
  StockWriter,
  WorkbookReader,
} from '../contracts';
import type { Product } from '../domain/product';
import { type ColumnMapping, detectMapping } from './import/column-mapping';
import { type ImportPlan, planImport } from './import/plan-import';
import { type ImageFailure, takeImages } from './import/take-images';

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
  /**
   * Every row as read, header included.
   *
   * Returned by reference — the reader already holds them, so this costs nothing
   * — and it is what lets the admin screen show a few real cells beside each
   * column while the operator maps it. Nothing here is sent to a browser
   * directly: toImportReport caps how many rows are exposed, in one tested place.
   */
  readonly rows: readonly (readonly string[])[];
  /** The mapping actually used, so the UI can show and edit it. */
  readonly mapping: ColumnMapping;
  readonly plan: ImportPlan;
  /** Products written. Always 0 for a dry run. */
  readonly written: number;
  /**
   * Products the database refused at write time.
   *
   * Should always be empty — the plan detects SKU conflicts before committing.
   * It is not guaranteed empty, because between the plan and the write someone
   * else can take a SKU, and a partial import that says so is very different
   * from one that reports success and quietly wrote less.
   */
  readonly failures: readonly { readonly slug: string; readonly conflict: SaveConflict }[];
  /** SKUs whose stock the sheet stated and the write refused. */
  readonly stockFailures: readonly StockWriteFailure[];
  /** SKUs whose stock this import set. Zero when the sheet had no stock column. */
  readonly stockWritten: number;
  /**
   * Images the shop could not take a copy of.
   *
   * The product still imported, without that picture. Reported by slug and URL
   * because the operator fixes a spreadsheet by row, not by hash.
   */
  readonly imageFailures: readonly ImageFailure[];
  /** Distinct supplier images fetched and stored. Zero on a dry run, always. */
  readonly imagesTaken: number;
  readonly committed: boolean;
};

export type ImportProducts = (
  input: ImportProductsInput,
) => Promise<Result<ImportProductsOutput, ImportProductsError>>;

export const makeImportProducts =
  (deps: {
    repository: ProductRepository;
    reader: WorkbookReader;
    /** Injected, not imported: see the note on the ports in ../contracts. */
    stock: StockWriter;
    images: ImageIngestor;
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
      ownerSlugBySku: new Map(),
      nextId: deps.nextId,
    });

    const slugs = [
      ...new Set([
        ...provisional.products.map((planned) => planned.product.slug),
        ...provisional.productProblems.map((problem) => problem.slug),
      ]),
    ];

    const skus = [
      ...new Set(
        provisional.products.flatMap((planned) =>
          planned.product.variants.map((variant) => variant.sku),
        ),
      ),
    ];

    /*
     * Two bulk lookups, in parallel, for the whole sheet.
     *
     * By slug: does this product exist, so is this a create or an update?
     * By SKU:  does this SKU already belong to something ELSE?
     *
     * The second is what stops a rename from becoming an E11000 halfway through
     * the write. Rename "Anker Cable" to "Anker Cable 2m", keep the SKU, and the
     * slug lookup finds nothing — so the plan says create, and the unique index
     * on the SKU refuses it after some other products have already been saved.
     */
    const [existing, skuOwners] = await Promise.all([
      slugs.length === 0 ? [] : deps.repository.findBySlugs(deps.storeId, slugs),
      skus.length === 0 ? [] : deps.repository.findBySkus(deps.storeId, skus),
    ]);

    const existingBySlug = new Map<string, Product>(
      existing.map((product) => [product.slug, product]),
    );

    const ownerSlugBySku = new Map<string, string>();
    for (const owner of skuOwners) {
      for (const variant of owner.variants) ownerSlugBySku.set(variant.sku, owner.slug);
    }

    const plan = planImport({
      rows,
      mapping,
      storeId: deps.storeId,
      now: deps.now(),
      existingBySlug,
      ownerSlugBySku,
      nextId: deps.nextId,
    });

    if (input.commit !== true) {
      return ok({
        headers,
        rows,
        mapping,
        plan,
        written: 0,
        failures: [],
        stockFailures: [],
        stockWritten: 0,
        /*
         * A dry run fetches NOTHING.
         *
         * A preview that pulled four hundred images off a supplier's CDN every
         * time an operator adjusted a column mapping would be a preview with a
         * cost, and previews are supposed to be free. It also means the plan
         * shown on screen still carries supplier URLs while the committed
         * products carry ours, which is the honest thing to show: nothing has
         * been taken yet.
         */
        imageFailures: [],
        imagesTaken: 0,
        committed: false,
      });
    }

    /*
     * Only the valid products are written. A sheet with three bad rows out of
     * four hundred should import three hundred and ninety seven, not nothing —
     * the operator fixes three rows and re-imports, rather than hunting for the
     * one cell that blocked everything.
     */
    /*
     * Copies of the images are taken BEFORE anything is written.
     *
     * The plan is pure and produces products still pointing at whatever the
     * spreadsheet said; this is where the catalogue stops depending on somebody
     * else's server. Doing it first means a product is never written with a
     * supplier URL that a later step would have to go back and correct.
     */
    const taken = await takeImages(plan.products, deps.images);

    let written = 0;
    const failures: { slug: string; conflict: SaveConflict }[] = [];
    const levels: { sku: string; onHand: number }[] = [];

    for (const planned of taken.products) {
      const product = planned.product;
      const saved = await deps.repository.save(product);
      if (saved.ok) {
        written++;
        // Stock is collected rather than written per product, so the whole
        // sheet costs one batch instead of one round trip per row. Only for
        // products that actually landed: setting stock for a product that was
        // refused would leave a level for something not in the catalogue.
        levels.push(...planned.stock);
        continue;
      }
      /*
       * A uniqueness conflict here means the catalogue changed between the plan
       * and this write. Recording it and carrying on is deliberate: stopping
       * would leave the operator with a 500, a partly-written catalogue and no
       * statement of which half landed. Anything that is NOT a conflict still
       * throws out of the repository, because a dropped connection must not be
       * reported as "397 of 400 imported".
       */
      failures.push({ slug: product.slug, conflict: saved.error });
    }

    /*
     * Stock is written AFTER the products, and only for the ones that landed.
     *
     * The other order would leave a stock level for a product the unique index
     * refused — a count for something not in the catalogue, which nothing would
     * ever reconcile.
     */
    const stockFailures = levels.length === 0 ? [] : await deps.stock.setLevels(levels);

    return ok({
      headers,
      rows,
      mapping,
      plan,
      written,
      imageFailures: taken.failures,
      imagesTaken: taken.taken,
      failures,
      stockFailures,
      stockWritten: levels.length - stockFailures.length,
      committed: true,
    });
  };
