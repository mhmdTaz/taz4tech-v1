import type { EntityId } from '@platform/ids';
import { englishOnly } from '@platform/locale';
import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { describe, expect, it } from 'vitest';
import type { Product } from '../../domain/product';
import { detectMapping } from './column-mapping';
import { SAMPLE_ROW_COUNT, toImportReport } from './import-report';
import { planImport } from './plan-import';

const NOW = new Date('2026-08-27T10:00:00Z');
const usd = (cents: number) => unwrapOrThrow(fromCents(cents));

let idCounter = 0;
const nextId = () => `PRODUCT${String(++idCounter).padStart(19, '0')}` as EntityId<'Product'>;

const HEADERS = [
  'SKU',
  'Title',
  'Title AR',
  'Price',
  'Brand',
  'Status',
  'Option1 Name',
  'Option1 Value',
  'Image URL',
];

/** [sku, title, titleAr, price, brand, status, optionName, optionValue, imageUrl] */
const row = (
  sku: string,
  title: string,
  price: string,
  extra: Partial<{
    titleAr: string;
    brand: string;
    status: string;
    optionName: string;
    optionValue: string;
    imageUrl: string;
  }> = {},
): string[] => [
  sku,
  title,
  extra.titleAr ?? '',
  price,
  extra.brand ?? '',
  extra.status ?? 'active',
  extra.optionName ?? '',
  extra.optionValue ?? '',
  extra.imageUrl ?? '',
];

const report = (rows: string[][], existing: Product[] = []) => {
  idCounter = 0;
  const all = [HEADERS, ...rows];
  const mapping = detectMapping(HEADERS);
  return toImportReport({
    headers: HEADERS,
    rows: all,
    mapping,
    plan: planImport({
      rows: all,
      mapping,
      storeId: 'taz4tech',
      now: NOW,
      existingBySlug: new Map(existing.map((product) => [product.slug, product])),
      ownerSlugBySku: new Map(),
      nextId,
    }),
    committed: false,
    written: 0,
    failures: [],
    stockFailures: [],
    stockWritten: 0,
    imageFailures: [],
    imagesTaken: 0,
  });
};

const existingProduct = (slug: string): Product => ({
  storeId: 'taz4tech',
  id: 'EXISTING000000000000000AA' as EntityId<'Product'>,
  slug,
  title: englishOnly('Old title'),
  description: englishOnly('Old description'),
  brand: null,
  status: 'active',
  optionNames: [],
  variants: [
    {
      sku: 'OLD-1',
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
  createdAt: NOW,
  updatedAt: NOW,
});

describe('toImportReport', () => {
  it('previews one product per planned product', () => {
    const result = report([row('A-1', 'Anker Cable', '19.99'), row('B-1', 'Belkin Hub', '39.00')]);

    expect(result.products).toHaveLength(2);
    expect(result.products.map((product) => product.slug)).toEqual(['anker-cable', 'belkin-hub']);
  });

  it('reports prices as integer cents, never as a formatted string', () => {
    // Formatting needs a locale, and this layer has no business knowing one.
    const [product] = report([row('A-1', 'Anker Cable', '19.99')]).products;

    expect(product?.priceFromCents).toBe(1999);
    expect(product?.priceToCents).toBe(1999);
    expect(product?.currency).toBe('USD');
  });

  it('spans the cheapest and dearest variant of a multi-variant product', () => {
    const result = report([
      row('A-1', 'Anker Cable', '19.99', { optionName: 'Length', optionValue: '1m' }),
      row('A-2', 'Anker Cable', '24.50', { optionName: 'Length', optionValue: '2m' }),
    ]);

    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.variantCount).toBe(2);
    expect(result.products[0]?.priceFromCents).toBe(1999);
    expect(result.products[0]?.priceToCents).toBe(2450);
  });

  it('says which rows a product came from, so a problem can be found in the sheet', () => {
    const result = report([
      row('A-1', 'Anker Cable', '19.99', { optionName: 'Length', optionValue: '1m' }),
      row('A-2', 'Anker Cable', '24.50', { optionName: 'Length', optionValue: '2m' }),
    ]);

    // Header is Excel row 1, so the two data rows are 2 and 3.
    expect(result.products[0]?.rows).toEqual([2, 3]);
  });

  it('distinguishes create from update', () => {
    const result = report(
      [row('A-1', 'Anker Cable', '19.99'), row('B-1', 'Belkin Hub', '39.00')],
      [existingProduct('anker-cable')],
    );

    expect(result.products.map((product) => [product.slug, product.action])).toEqual([
      ['anker-cable', 'update'],
      ['belkin-hub', 'create'],
    ]);
  });

  it('lists the locales a title actually has', () => {
    // This is what drives the "needs translating" nudge in the preview. A title
    // present only in English must not read as translated.
    const result = report([
      row('A-1', 'Anker Cable', '19.99', { titleAr: 'كابل انكر' }),
      row('B-1', 'Belkin Hub', '39.00'),
    ]);

    expect(result.products[0]?.translatedInto).toEqual(['en', 'ar']);
    expect(result.products[1]?.translatedInto).toEqual(['en']);
  });

  it('counts images without carrying the media objects', () => {
    const result = report([
      row('A-1', 'Anker Cable', '19.99', { imageUrl: 'https://cdn.example/a.jpg' }),
    ]);

    expect(result.products[0]?.imageCount).toBe(1);
    expect(result.products[0]).not.toHaveProperty('media');
  });

  it('carries the summary through untouched', () => {
    const result = report(
      [row('A-1', 'Anker Cable', '19.99'), row('B-1', 'Belkin Hub', '39.00')],
      [existingProduct('anker-cable')],
    );

    expect(result.summary).toEqual({
      dataRows: 2,
      products: 2,
      toCreate: 1,
      toUpdate: 1,
      rowsRejected: 0,
    });
  });

  it('passes row problems through with their Excel row numbers', () => {
    const result = report([row('A-1', 'Anker Cable', 'not a price')]);

    expect(result.rowProblems).toEqual([
      { row: 2, field: 'price', problem: { tag: 'unparsable_money', value: 'not a price' } },
    ]);
    expect(result.products).toEqual([]);
  });

  it('passes product problems through', () => {
    // Two rows sharing a slug but disagreeing about the option name is a product
    // the domain refuses, not a cell the parser refuses.
    const result = report([
      row('A-1', 'Anker Cable', '19.99', { optionName: 'Length', optionValue: '1m' }),
      row('A-2', 'Anker Cable', '24.50', { optionName: 'Colour', optionValue: 'Black' }),
    ]);

    expect(result.productProblems).toHaveLength(1);
    expect(result.productProblems[0]?.slug).toBe('anker-cable');
    expect(result.productProblems[0]?.rows).toEqual([2, 3]);
  });

  it('surfaces mapping problems rather than pretending the sheet is fine', () => {
    const headers = ['Colour', 'Notes'];
    const rows = [headers, ['Black', 'nothing useful']];
    const mapping = detectMapping(headers);

    const result = toImportReport({
      headers,
      rows,
      mapping,
      plan: planImport({
        rows,
        mapping,
        storeId: 'taz4tech',
        now: NOW,
        existingBySlug: new Map(),
        ownerSlugBySku: new Map(),
        nextId,
      }),
      committed: false,
      written: 0,
      failures: [],
      stockFailures: [],
      stockWritten: 0,
      imageFailures: [],
      imagesTaken: 0,
    });

    expect(result.mappingProblems.map((problem) => problem.field)).toEqual([
      'titleEn',
      'sku',
      'price',
    ]);
  });

  describe('the sample rows', () => {
    it('excludes the header row, which is not data', () => {
      const result = report([row('A-1', 'Anker Cable', '19.99')]);
      expect(result.sampleRows).toEqual([row('A-1', 'Anker Cable', '19.99')]);
    });

    it('is capped, so a four-hundred-row sheet does not become a four-hundred-row payload', () => {
      const rows = Array.from({ length: 40 }, (_, i) => row(`A-${i}`, `Product ${i}`, '10.00'));
      expect(report(rows).sampleRows).toHaveLength(SAMPLE_ROW_COUNT);
    });

    it('includes rows that failed to parse, because those are the ones worth seeing', () => {
      const result = report([row('A-1', 'Anker Cable', 'not a price')]);
      expect(result.sampleRows).toHaveLength(1);
    });
  });

  describe('the commit receipt', () => {
    it('reuses the preview shape, so one component renders both', () => {
      const all = [HEADERS, row('A-1', 'Anker Cable', '19.99')];
      const mapping = detectMapping(HEADERS);
      const result = toImportReport({
        headers: HEADERS,
        rows: all,
        mapping,
        plan: planImport({
          rows: all,
          mapping,
          storeId: 'taz4tech',
          now: NOW,
          existingBySlug: new Map(),
          ownerSlugBySku: new Map(),
          nextId,
        }),
        committed: true,
        written: 1,
        failures: [],
        stockFailures: [],
        stockWritten: 0,
        imageFailures: [],
        imagesTaken: 0,
      });

      expect(result.committed).toBe(true);
      expect(result.written).toBe(1);
      expect(result.products).toHaveLength(1);
    });
  });

  describe('conflicts and failures', () => {
    const withPlan = (
      overrides: Partial<Parameters<typeof toImportReport>[0]> = {},
    ): ReturnType<typeof toImportReport> => {
      // Built as a complete input first, then overridden. Spreading a Partial
      // into an object literal makes every overridden field OPTIONAL under
      // exactOptionalPropertyTypes, which the parameter type then refuses.
      const all = [HEADERS, row('A-1', 'Anker Cable', '19.99')];
      const mapping = detectMapping(HEADERS);
      idCounter = 0;
      const base: Parameters<typeof toImportReport>[0] = {
        headers: HEADERS,
        rows: all,
        mapping,
        plan: planImport({
          rows: all,
          mapping,
          storeId: 'taz4tech',
          now: NOW,
          existingBySlug: new Map(),
          ownerSlugBySku: new Map(),
          nextId,
        }),
        committed: false,
        written: 0,
        failures: [],
        stockFailures: [],
        stockWritten: 0,
        imageFailures: [],
        imagesTaken: 0,
      };

      return toImportReport(Object.assign(base, overrides));
    };

    it('carries a SKU conflict through with the slug that owns it', () => {
      const all = [HEADERS, row('A-1', 'Anker Cable 2m', '19.99')];
      const mapping = detectMapping(HEADERS);
      idCounter = 0;

      const result = toImportReport({
        headers: HEADERS,
        rows: all,
        mapping,
        plan: planImport({
          rows: all,
          mapping,
          storeId: 'taz4tech',
          now: NOW,
          existingBySlug: new Map(),
          ownerSlugBySku: new Map([['A-1', 'anker-cable']]),
          nextId,
        }),
        committed: false,
        written: 0,
        failures: [],
        stockFailures: [],
        stockWritten: 0,
        imageFailures: [],
        imagesTaken: 0,
      });

      expect(result.skuConflicts).toEqual([
        { rows: [2], slug: 'anker-cable-2m', sku: 'A-1', ownedBySlug: 'anker-cable' },
      ]);
      expect(result.products).toEqual([]);
    });

    it('explains a SKU that was taken mid-import', () => {
      const result = withPlan({
        committed: true,
        written: 0,
        failures: [{ slug: 'anker-cable', conflict: { tag: 'sku_taken', sku: 'A-1' } }],
      });

      expect(result.failures).toEqual([
        { slug: 'anker-cable', reason: 'the SKU A-1 was taken while this import was running' },
      ]);
    });

    it('explains a slug that was taken mid-import', () => {
      const result = withPlan({
        committed: true,
        written: 0,
        failures: [{ slug: 'anker-cable', conflict: { tag: 'slug_taken', slug: 'anker-cable' } }],
      });

      expect(result.failures[0]?.reason).toContain('URL slug anker-cable was taken');
    });

    it('has no failures for an ordinary import', () => {
      expect(withPlan({}).failures).toEqual([]);
      expect(withPlan({}).skuConflicts).toEqual([]);
    });
  });

  it('produces something structuredClone can carry to the browser', () => {
    // The whole reason this function exists. A Product holds Money and Date
    // objects; if any of them leaked in here, the client boundary would either
    // reject it or silently reshape it.
    const result = report([
      row('A-1', 'Anker Cable', '19.99', { imageUrl: 'https://cdn.example/a.jpg' }),
      row('B-1', 'Belkin Hub', 'not a price'),
    ]);

    expect(() => structuredClone(result)).not.toThrow();
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
