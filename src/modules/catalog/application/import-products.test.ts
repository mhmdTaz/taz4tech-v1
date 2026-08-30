import type { EntityId } from '@platform/ids';
import { englishOnly } from '@platform/locale';
import { fromCents } from '@platform/money';
import { err, ok, unwrapOrThrow } from '@platform/result';
import { describe, expect, it, vi } from 'vitest';
import type { ImageIngestor, ProductRepository, StockWriter, WorkbookReader } from '../contracts';
import type { Product } from '../domain/product';
import { makeImportProducts } from './import-products';

const NOW = new Date('2026-08-27T10:00:00Z');
const usd = (cents: number) => unwrapOrThrow(fromCents(cents));

const SHEET: string[][] = [
  ['SKU', 'Title', 'Price', 'Status'],
  ['A-1', 'Anker Cable', '19.00', 'active'],
  ['B-1', 'Logitech Mouse', '29.00', 'active'],
];

const reader = (rows: string[][] | Error): WorkbookReader => ({
  readRows: vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  }),
});

const repository = (existing: Product[] = []) => {
  const saved: Product[] = [];
  const repo: ProductRepository = {
    findBySlug: vi.fn().mockResolvedValue(null),
    findById: vi.fn(),
    findBySku: vi.fn(),
    search: vi.fn(),
    findBySlugs: vi.fn(async (_storeId: string, slugs: readonly string[]) =>
      existing.filter((product) => slugs.includes(product.slug)),
    ),
    // Mirrors the unique index: a SKU belongs to exactly one product per store.
    findBySkus: vi.fn(async (_storeId: string, skus: readonly string[]) =>
      existing.filter((product) => product.variants.some((v) => skus.includes(v.sku))),
    ),
    findByIds: vi.fn(async () => []),
    list: vi.fn(),
    save: vi.fn(async (product: Product) => {
      saved.push(product);
      return ok(undefined);
    }),
  };
  return { repo, saved };
};

let counter = 0;

/**
 * Takes every image without asking anyone.
 *
 * These tests are about parsing a spreadsheet and writing a catalogue; taking
 * copies of images has its own file. A fake that rewrote URLs would make every
 * assertion here about media as well, for no gain.
 */
const imageIngestor = (): ImageIngestor => ({
  take: async (url: string) => ({ ok: true, path: url }),
});

/** Records what the sheet's stock column asked for, and can refuse a SKU. */
const stockWriter = (refuse: readonly string[] = []) => {
  const written: { sku: string; onHand: number }[] = [];
  const writer: StockWriter = {
    setLevels: async (levels) => {
      const failures: { sku: string; reason: string }[] = [];
      for (const level of levels) {
        if (refuse.includes(level.sku)) failures.push({ sku: level.sku, reason: 'refused' });
        else written.push({ ...level });
      }
      return failures;
    },
  };
  return { writer, written };
};

const importer = (
  repo: ProductRepository,
  workbook: WorkbookReader,
  stock: StockWriter = stockWriter().writer,
) => {
  counter = 0;
  return makeImportProducts({
    repository: repo,
    reader: workbook,
    stock,
    images: imageIngestor(),
    storeId: 'taz4tech',
    now: () => NOW,
    nextId: () => `PRODUCT${String(++counter).padStart(19, '0')}` as EntityId<'Product'>,
  });
};

const file = new Uint8Array([1, 2, 3]);

/** Header row for the sheets the conflict tests build inline. */
const HEADERS = ['SKU', 'Title', 'Price'];

const existingProduct = (slug: string, sku = 'OLD'): Product => ({
  storeId: 'taz4tech',
  id: 'EXISTING000000000000000AA' as EntityId<'Product'>,
  slug,
  title: englishOnly('Old'),
  description: englishOnly('Old'),
  brand: null,
  status: 'active',
  optionNames: [],
  variants: [
    {
      sku,
      options: [],
      price: usd(100),
      compareAtPrice: null,
      offerEndsAt: null,
      barcode: null,
      weightGrams: null,
    },
  ],
  media: [],
  specs: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
});

describe('importProducts', () => {
  it('previews without writing anything by default', async () => {
    // The default has to be safe: an import that writes because a flag was
    // forgotten is the failure this whole feature exists to prevent.
    const { repo, saved } = repository();
    const result = await importer(repo, reader(SHEET))({ file });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected a preview, got ${result.error.tag}`);
    expect(result.value.committed).toBe(false);
    expect(result.value.written).toBe(0);
    expect(result.value.plan.products).toHaveLength(2);

    /*
     * And nothing failed, because nothing was attempted. These three are what
     * the preview screen counts to decide whether to show a problems panel at
     * all, so a dry run that reported a failure it invented would send the
     * operator looking for a row that is perfectly fine.
     */
    expect(result.value.failures).toEqual([]);
    expect(result.value.stockFailures).toEqual([]);
    expect(result.value.imageFailures).toEqual([]);
    expect(result.value.stockWritten).toBe(0);
    expect(result.value.imagesTaken).toBe(0);

    expect(saved).toEqual([]);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('does not write when commit is explicitly false', async () => {
    const { repo, saved } = repository();
    await importer(repo, reader(SHEET))({ file, commit: false });
    expect(saved).toEqual([]);
  });

  it('writes only when commit is true', async () => {
    const { repo, saved } = repository();
    const result = await importer(repo, reader(SHEET))({ file, commit: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.committed).toBe(true);
      expect(result.value.written).toBe(2);
    }
    expect(saved.map((product) => product.slug)).toEqual(['anker-cable', 'logitech-mouse']);
  });

  it('returns the headers and the mapping it used', async () => {
    const { repo } = repository();
    const result = await importer(repo, reader(SHEET))({ file });

    if (result.ok) {
      expect(result.value.headers).toEqual(['SKU', 'Title', 'Price', 'Status']);
      expect(result.value.mapping).toEqual({ sku: 0, titleEn: 1, price: 2, status: 3 });
    }
  });

  it('honours a mapping supplied by the operator over auto-detection', async () => {
    // Detection is a suggestion. If the operator says column 0 is the title,
    // that is the answer, however the header happens to be spelled.
    const { repo } = repository();
    const result = await importer(
      repo,
      reader([
        ['Column A', 'Column B', 'Column C'],
        ['Widget', 'W-1', '5.00'],
      ]),
    )({ file, mapping: { titleEn: 0, sku: 1, price: 2 } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plan.products[0]?.product.title.en).toBe('Widget');
    }
  });

  it('looks existing products up in ONE query, not one per row', async () => {
    // Four hundred round trips to Atlas is the difference between a preview that
    // appears and one that times out.
    const { repo } = repository([existingProduct('anker-cable')]);
    await importer(repo, reader(SHEET))({ file });

    expect(repo.findBySlugs).toHaveBeenCalledOnce();
    expect(repo.findBySlug).not.toHaveBeenCalled();
  });

  it('marks a known slug as an update and an unknown one as a create', async () => {
    const { repo } = repository([existingProduct('anker-cable')]);
    const result = await importer(repo, reader(SHEET))({ file });

    if (result.ok) {
      const byslug = new Map(
        result.value.plan.products.map((planned) => [planned.product.slug, planned.action]),
      );
      expect(byslug.get('anker-cable')).toBe('update');
      expect(byslug.get('logitech-mouse')).toBe('create');
      expect(result.value.plan.summary.toUpdate).toBe(1);
      expect(result.value.plan.summary.toCreate).toBe(1);
    }
  });

  it('imports the good rows and reports the bad ones', async () => {
    // Three bad rows out of four hundred should import three hundred and ninety
    // seven, not nothing.
    const { repo, saved } = repository();
    const result = await importer(
      repo,
      reader([
        ['SKU', 'Title', 'Price'],
        ['A-1', 'Anker Cable', '19.00'],
        ['B-1', 'Broken', 'free'],
        ['C-1', 'Dell Monitor', '199.00'],
      ]),
    )({ file, commit: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.written).toBe(2);
      expect(result.value.plan.rowProblems).toHaveLength(1);
      expect(result.value.plan.rowProblems[0]?.row).toBe(3);
    }
    expect(saved).toHaveLength(2);
  });

  it('reports a product the domain rejects, and writes nothing for it', async () => {
    // A compare-at price with no expiry is rejected by the domain, because
    // consumer protection law requires every offer to carry one. The slug still
    // has to be looked up, so the preview can say whether the product it would
    // have replaced already exists.
    const { repo, saved } = repository([existingProduct('anker-cable')]);
    const result = await importer(
      repo,
      reader([
        ['SKU', 'Title', 'Price', 'Compare At Price'],
        ['A-1', 'Anker Cable', '19.00', '25.00'],
        ['B-1', 'Logitech Mouse', '29.00', ''],
      ]),
    )({ file, commit: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plan.productProblems).toHaveLength(1);
      expect(result.value.plan.productProblems[0]?.slug).toBe('anker-cable');
      expect(result.value.plan.productProblems[0]?.reason.tag).toBe('offer_without_end_date');
      // The good row still imports.
      expect(result.value.written).toBe(1);
    }
    expect(saved.map((product) => product.slug)).toEqual(['logitech-mouse']);
    // The rejected product's slug was included in the single lookup.
    expect(repo.findBySlugs).toHaveBeenCalledWith('taz4tech', ['logitech-mouse', 'anker-cable']);
  });

  it('reports an unreadable file as an error, not a crash', async () => {
    // A corrupt upload is an expected outcome of accepting files from a browser.
    const { repo } = repository();
    const result = await importer(repo, reader(new Error('not a zip')))({ file });

    expect(result).toMatchObject({
      ok: false,
      error: { tag: 'file_unreadable', reason: 'not a zip' },
    });
  });

  it('handles a thrown non-Error without losing the failure', async () => {
    const { repo } = repository();
    const workbook: WorkbookReader = {
      readRows: vi.fn(async () => {
        throw 'something odd';
      }),
    };
    const result = await importer(repo, workbook)({ file });
    expect(result).toMatchObject({
      ok: false,
      error: { tag: 'file_unreadable', reason: 'unknown' },
    });
  });

  it('reports an empty sheet', async () => {
    const { repo } = repository();
    for (const rows of [[], [[]]]) {
      const result = await importer(repo, reader(rows))({ file });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('sheet_empty');
    }
  });

  it('does not query at all when the sheet yields no usable slugs', async () => {
    const { repo } = repository();
    const result = await importer(repo, reader([['SKU', 'Title', 'Price']]))({ file });

    expect(result.ok).toBe(true);
    expect(repo.findBySlugs).not.toHaveBeenCalled();
    // Both lookups, not just the first. An empty `$in` is a round trip to Mongo
    // for a set it has already been told is empty.
    expect(repo.findBySkus).not.toHaveBeenCalled();
  });

  it('surfaces a mapping problem instead of importing nonsense', async () => {
    const { repo, saved } = repository();
    const result = await importer(
      repo,
      reader([
        ['Title', 'Price'],
        ['Anker Cable', '19.00'],
      ]),
    )({ file, commit: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plan.mappingProblems.map((p) => p.field)).toEqual(['sku']);
      expect(result.value.written).toBe(0);
    }
    expect(saved).toEqual([]);
  });

  it('lets a repository write failure propagate', async () => {
    const { repo } = repository();
    repo.save = vi.fn().mockRejectedValue(new Error('write concern timeout'));
    await expect(importer(repo, reader(SHEET))({ file, commit: true })).rejects.toThrow(
      'write concern timeout',
    );
  });
});

describe('a SKU that already belongs to another product', () => {
  /*
   * The failure this exists to prevent, in full:
   *
   *   1. "Anker Cable" exists, slug anker-cable, SKU ANK-1.
   *   2. The operator renames it in the sheet to "Anker Cable 2m".
   *   3. The slug becomes anker-cable-2m, which does not exist.
   *   4. The plan says CREATE, and the unique index on the SKU refuses the
   *      write — after everything before it in the sheet has been saved.
   *
   * The operator sees a 500 and a half-imported catalogue.
   */
  const owner = existingProduct('anker-cable', 'ANK-1');

  it('is reported as a conflict rather than planned as a create', async () => {
    const { repo } = repository([owner]);
    const result = await importer(
      repo,
      reader([HEADERS, ['ANK-1', 'Anker Cable 2m', '19.99']]),
    )({
      file,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.plan.products).toEqual([]);
    expect(result.value.plan.skuConflicts).toEqual([
      { rows: [2], slug: 'anker-cable-2m', sku: 'ANK-1', ownedBySlug: 'anker-cable' },
    ]);
  });

  it('counts its rows as rejected, so the summary is not quietly optimistic', async () => {
    const { repo } = repository([owner]);
    const result = await importer(
      repo,
      reader([HEADERS, ['ANK-1', 'Anker Cable 2m', '19.99']]),
    )({
      file,
    });

    if (!result.ok) return;
    expect(result.value.plan.summary.rowsRejected).toBe(1);
    expect(result.value.plan.summary.products).toBe(0);
  });

  it('does not write it even when the caller commits', async () => {
    const { repo, saved } = repository([owner]);
    const result = await importer(
      repo,
      reader([HEADERS, ['ANK-1', 'Anker Cable 2m', '19.99']]),
    )({
      file,
      commit: true,
    });

    if (!result.ok) return;
    expect(saved).toEqual([]);
    expect(result.value.written).toBe(0);
  });

  it('lets the rest of the sheet through', async () => {
    // The rule everywhere in this importer: one bad product must not stop 399
    // good ones.
    const { repo, saved } = repository([owner]);
    const result = await importer(
      repo,
      reader([HEADERS, ['ANK-1', 'Anker Cable 2m', '19.99'], ['LOG-1', 'Logitech Mouse', '29.99']]),
    )({ file, commit: true });

    if (!result.ok) return;
    expect(result.value.written).toBe(1);
    expect(saved.map((product) => product.slug)).toEqual(['logitech-mouse']);
  });

  it('is NOT a conflict when the same product keeps its own SKU', async () => {
    // The ordinary case — a re-imported price list — must stay an update.
    const { repo } = repository([owner]);
    const result = await importer(
      repo,
      reader([HEADERS, ['ANK-1', 'Anker Cable', '24.99']]),
    )({
      file,
    });

    if (!result.ok) return;
    expect(result.value.plan.skuConflicts).toEqual([]);
    expect(result.value.plan.products.map((planned) => planned.action)).toEqual(['update']);
  });

  it('looks the SKUs up once, in bulk', async () => {
    const { repo } = repository([owner]);
    await importer(
      repo,
      reader([HEADERS, ['ANK-1', 'A', '1.00'], ['LOG-1', 'B', '2.00']]),
    )({ file });

    expect(repo.findBySkus).toHaveBeenCalledOnce();
    expect(repo.findBySkus).toHaveBeenCalledWith('taz4tech', ['ANK-1', 'LOG-1']);
  });
});

describe('a write that loses a race', () => {
  /*
   * Even with the check above, two imports running at once can both plan a
   * create and only one can win. What must NOT happen is a 500 that leaves the
   * operator guessing how much of their catalogue landed.
   */
  const conflictingRepository = (takenSku: string) => {
    const saved: Product[] = [];
    const repo: ProductRepository = {
      findBySlug: vi.fn().mockResolvedValue(null),
      findById: vi.fn(),
      findBySku: vi.fn(),
      search: vi.fn(),
      findBySlugs: vi.fn().mockResolvedValue([]),
      findBySkus: vi.fn().mockResolvedValue([]),
      findByIds: vi.fn().mockResolvedValue([]),
      list: vi.fn(),
      save: vi.fn(async (product: Product) => {
        if (product.variants.some((variant) => variant.sku === takenSku)) {
          return err({ tag: 'sku_taken' as const, sku: takenSku });
        }
        saved.push(product);
        return ok(undefined);
      }),
    };
    return { repo, saved };
  };

  it('reports the failure instead of throwing', async () => {
    const { repo } = conflictingRepository('ANK-1');
    const result = await importer(
      repo,
      reader([HEADERS, ['ANK-1', 'Anker Cable', '19.99']]),
    )({
      file,
      commit: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written).toBe(0);
    expect(result.value.failures).toEqual([
      { slug: 'anker-cable', conflict: { tag: 'sku_taken', sku: 'ANK-1' } },
    ]);
  });

  it('keeps writing the products after it', async () => {
    const { repo, saved } = conflictingRepository('ANK-1');
    const result = await importer(
      repo,
      reader([HEADERS, ['ANK-1', 'Anker Cable', '19.99'], ['LOG-1', 'Logitech Mouse', '29.99']]),
    )({ file, commit: true });

    if (!result.ok) return;
    expect(result.value.written).toBe(1);
    expect(result.value.failures).toHaveLength(1);
    expect(saved.map((product) => product.slug)).toEqual(['logitech-mouse']);
  });

  it('still throws on something that is not a conflict', async () => {
    // A dropped connection is not an expected outcome of importing a sheet, and
    // must never be reported as a partial success.
    const repo: ProductRepository = {
      findBySlug: vi.fn().mockResolvedValue(null),
      findById: vi.fn(),
      findBySku: vi.fn(),
      search: vi.fn(),
      findBySlugs: vi.fn().mockResolvedValue([]),
      findBySkus: vi.fn().mockResolvedValue([]),
      findByIds: vi.fn().mockResolvedValue([]),
      list: vi.fn(),
      save: vi.fn().mockRejectedValue(new Error('connection reset')),
    };

    await expect(
      importer(
        repo,
        reader([HEADERS, ['ANK-1', 'Anker Cable', '19.99']]),
      )({
        file,
        commit: true,
      }),
    ).rejects.toThrow('connection reset');
  });
});

describe('the stock column', () => {
  const STOCK_HEADERS = ['SKU', 'Title', 'Price', 'Stock'];

  it('writes the stated level for each SKU on commit', async () => {
    const { repo } = repository();
    const stock = stockWriter();

    const result = await importer(
      repo,
      reader([STOCK_HEADERS, ['A-1', 'Anker Cable', '19.99', '7']]),
      stock.writer,
    )({ file, commit: true });

    if (!result.ok) return;
    expect(stock.written).toEqual([{ sku: 'A-1', onHand: 7 }]);
    expect(result.value.stockWritten).toBe(1);
  });

  it('writes nothing on a dry run', async () => {
    // The importer's whole promise: a preview writes nothing, including stock.
    const { repo } = repository();
    const stock = stockWriter();

    await importer(
      repo,
      reader([STOCK_HEADERS, ['A-1', 'Anker Cable', '19.99', '7']]),
      stock.writer,
    )({ file });

    expect(stock.written).toEqual([]);
  });

  it('treats a BLANK cell as "not counted", not as zero', async () => {
    /*
     * The distinction the whole column rests on. Importing a blank as zero would
     * take a catalogue off sale on the strength of an empty column — and the
     * inventory module reads "no record" as available precisely so that an
     * uncounted SKU stays buyable.
     */
    const { repo } = repository();
    const stock = stockWriter();

    await importer(
      repo,
      reader([STOCK_HEADERS, ['A-1', 'Anker Cable', '19.99', '']]),
      stock.writer,
    )({ file, commit: true });

    expect(stock.written).toEqual([]);
  });

  it('does write an explicit zero, which means sold out', async () => {
    const { repo } = repository();
    const stock = stockWriter();

    await importer(
      repo,
      reader([STOCK_HEADERS, ['A-1', 'Anker Cable', '19.99', '0']]),
      stock.writer,
    )({ file, commit: true });

    expect(stock.written).toEqual([{ sku: 'A-1', onHand: 0 }]);
  });

  it('writes one level per variant row', async () => {
    const { repo } = repository();
    const stock = stockWriter();

    await importer(
      repo,
      reader([
        [...STOCK_HEADERS, 'Option1 Name', 'Option1 Value'],
        ['A-1', 'Anker Cable', '19.99', '3', 'Length', '1m'],
        ['A-2', 'Anker Cable', '24.50', '5', 'Length', '2m'],
      ]),
      stock.writer,
    )({ file, commit: true });

    expect(stock.written).toEqual([
      { sku: 'A-1', onHand: 3 },
      { sku: 'A-2', onHand: 5 },
    ]);
  });

  it('rejects an unreadable quantity as a row problem', async () => {
    const { repo } = repository();
    const result = await importer(
      repo,
      reader([STOCK_HEADERS, ['A-1', 'Anker Cable', '19.99', 'a few']]),
    )({ file });

    if (!result.ok) return;
    expect(result.value.plan.rowProblems).toEqual([
      { row: 2, field: 'stock', problem: { tag: 'unparsable_number', value: 'a few' } },
    ]);
  });

  it('does not set stock for a product the database refused', async () => {
    /*
     * Order matters: a level written for a product that did not land is a count
     * for something not in the catalogue, and nothing would ever reconcile it.
     */
    const { repo } = repository();
    const stock = stockWriter();
    const refusing: ProductRepository = {
      ...repo,
      save: vi.fn(async () => err({ tag: 'sku_taken' as const, sku: 'A-1' })),
    };

    const result = await importer(
      refusing,
      reader([STOCK_HEADERS, ['A-1', 'Anker Cable', '19.99', '7']]),
      stock.writer,
    )({ file, commit: true });

    if (!result.ok) return;
    expect(stock.written).toEqual([]);
    expect(result.value.stockWritten).toBe(0);
  });

  it('reports a stock write it could not make, without failing the import', async () => {
    const { repo } = repository();
    const stock = stockWriter(['A-1']);

    const result = await importer(
      repo,
      reader([STOCK_HEADERS, ['A-1', 'Anker Cable', '19.99', '7']]),
      stock.writer,
    )({ file, commit: true });

    if (!result.ok) return;
    // The product landed; only its count did not, and the receipt says so.
    expect(result.value.written).toBe(1);
    expect(result.value.stockWritten).toBe(0);
    expect(result.value.stockFailures).toEqual([{ sku: 'A-1', reason: 'refused' }]);
  });

  it('does not call the writer at all when the sheet has no stock column', async () => {
    const setLevels = vi.fn(async () => []);
    const { repo } = repository();

    await importer(repo, reader(SHEET), { setLevels })({ file, commit: true });
    expect(setLevels).not.toHaveBeenCalled();
  });
});
