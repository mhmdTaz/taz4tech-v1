import type { EntityId } from '@platform/ids';
import { englishOnly } from '@platform/locale';
import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { describe, expect, it, vi } from 'vitest';
import type { ProductRepository, WorkbookReader } from '../contracts';
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
    findBySlugs: vi.fn(async (_storeId: string, slugs: readonly string[]) =>
      existing.filter((product) => slugs.includes(product.slug)),
    ),
    list: vi.fn(),
    save: vi.fn(async (product: Product) => {
      saved.push(product);
    }),
  };
  return { repo, saved };
};

let counter = 0;
const importer = (repo: ProductRepository, workbook: WorkbookReader) => {
  counter = 0;
  return makeImportProducts({
    repository: repo,
    reader: workbook,
    storeId: 'taz4tech',
    now: () => NOW,
    nextId: () => `PRODUCT${String(++counter).padStart(19, '0')}` as EntityId<'Product'>,
  });
};

const file = new Uint8Array([1, 2, 3]);

const existingProduct = (slug: string): Product => ({
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
      sku: 'OLD',
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
    if (result.ok) {
      expect(result.value.committed).toBe(false);
      expect(result.value.written).toBe(0);
      expect(result.value.plan.products).toHaveLength(2);
    }
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

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.tag === 'file_unreadable') {
      expect(result.error.reason).toBe('not a zip');
    }
  });

  it('handles a thrown non-Error without losing the failure', async () => {
    const { repo } = repository();
    const workbook: WorkbookReader = {
      readRows: vi.fn(async () => {
        throw 'something odd';
      }),
    };
    const result = await importer(repo, workbook)({ file });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.tag === 'file_unreadable') {
      expect(result.error.reason).toBe('unknown');
    }
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
