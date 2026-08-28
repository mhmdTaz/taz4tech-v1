import type { EntityId } from '@platform/ids';
import { englishOnly } from '@platform/locale';
import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { describe, expect, it } from 'vitest';
import type { Product } from '../../domain/product';
import { detectMapping } from './column-mapping';
import { planImport } from './plan-import';

const NOW = new Date('2026-08-27T10:00:00Z');
const usd = (cents: number) => unwrapOrThrow(fromCents(cents));

let idCounter = 0;
const nextId = () => `PRODUCT${String(++idCounter).padStart(19, '0')}` as EntityId<'Product'>;

const HEADERS = [
  'SKU',
  'Title',
  'Price',
  'Brand',
  'Status',
  'Option1 Name',
  'Option1 Value',
  'Compare At Price',
  'Offer Ends At',
];

const plan = (rows: string[][], existing: Product[] = [], headers: string[] = HEADERS) => {
  idCounter = 0;
  return planImport({
    rows: [headers, ...rows],
    mapping: detectMapping(headers),
    storeId: 'taz4tech',
    now: NOW,
    existingBySlug: new Map(existing.map((product) => [product.slug, product])),
    ownerSlugBySku: new Map(),
    nextId,
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
  specs: [{ name: englishOnly('RAM'), value: englishOnly('8 GB'), group: null }],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
});

describe('planImport', () => {
  it('turns a simple sheet into one product per row', () => {
    const result = plan([
      ['A-1', 'Anker Cable', '19.00', 'Anker', 'active', '', '', '', ''],
      ['B-1', 'Logitech Mouse', '29.00', 'Logitech', 'active', '', '', '', ''],
    ]);

    expect(result.products).toHaveLength(2);
    expect(result.summary.toCreate).toBe(2);
    expect(result.rowProblems).toEqual([]);
    expect(result.productProblems).toEqual([]);
  });

  it('groups rows that share a slug into ONE product with many variants', () => {
    // The single most important behaviour: a catalogue sheet has one row per
    // variant, so three IdeaPad rows are one product, not three.
    const result = plan([
      ['IP3-BLK', 'Lenovo IdeaPad 3', '1199.00', 'Lenovo', 'active', 'Colour', 'Black', '', ''],
      ['IP3-SLV', 'Lenovo IdeaPad 3', '1249.00', 'Lenovo', 'active', 'Colour', 'Silver', '', ''],
      ['IP3-RED', 'Lenovo IdeaPad 3', '1259.00', 'Lenovo', 'active', 'Colour', 'Red', '', ''],
    ]);

    expect(result.products).toHaveLength(1);
    const planned = result.products[0];
    expect(planned?.product.variants).toHaveLength(3);
    expect(planned?.product.optionNames).toEqual(['Colour']);
    expect(planned?.product.slug).toBe('lenovo-ideapad-3');
  });

  it('reports the Excel row numbers a product came from', () => {
    // The header is row 1, so the first data row is row 2. An operator reads
    // these back against the file they uploaded.
    const result = plan([
      ['IP3-BLK', 'Lenovo IdeaPad 3', '1199.00', '', '', 'Colour', 'Black', '', ''],
      ['IP3-SLV', 'Lenovo IdeaPad 3', '1249.00', '', '', 'Colour', 'Silver', '', ''],
    ]);
    expect(result.products[0]?.rows).toEqual([2, 3]);
  });

  it('derives a slug from the title when the sheet has no slug column', () => {
    const result = plan([['A-1', 'Anker USB-C Cable, 2 m', '19.00', '', '', '', '', '', '']]);
    expect(result.products[0]?.product.slug).toBe('anker-usb-c-cable-2-m');
  });

  it('uses an explicit slug column when the sheet has one', () => {
    // A supplier sheet that carries handles must keep them: the slug is the URL,
    // and deriving a different one silently breaks every link already published.
    const headers = ['Handle', 'SKU', 'Title', 'Price'];
    const result = plan([['custom-handle', 'A-1', 'Anker Cable', '19.00']], [], headers);
    expect(result.products[0]?.product.slug).toBe('custom-handle');
  });

  it('slugifies an explicit slug rather than trusting it', () => {
    const headers = ['Handle', 'SKU', 'Title', 'Price'];
    const result = plan([['Not A Slug!', 'A-1', 'Anker Cable', '19.00']], [], headers);
    expect(result.products[0]?.product.slug).toBe('not-a-slug');
  });

  it('carries Arabic and French titles through', () => {
    const headers = ['SKU', 'Title', 'Title AR', 'Title FR', 'Price'];
    const result = plan([['A-1', 'Cable', 'كابل', 'Cable FR', '19.00']], [], headers);
    const title = result.products[0]?.product.title;
    expect(title?.en).toBe('Cable');
    expect(title?.ar).toBe('كابل');
    expect(title?.fr).toBe('Cable FR');
  });

  it('uses a supplied image alt in preference to the title', () => {
    const headers = ['SKU', 'Title', 'Price', 'Image Src', 'Image Alt'];
    const result = plan(
      [['A-1', 'Anker Cable', '19.00', '/a.webp', 'A braided cable, coiled']],
      [],
      headers,
    );
    expect(result.products[0]?.product.media[0]?.alt.en).toBe('A braided cable, coiled');
  });

  it('marks a product that already exists as an update and keeps its id', () => {
    const existing = existingProduct('anker-cable');
    const result = plan(
      [['A-1', 'Anker Cable', '19.00', '', 'active', '', '', '', '']],
      [existing],
    );

    expect(result.products[0]?.action).toBe('update');
    expect(result.products[0]?.product.id).toBe(existing.id);
    expect(result.summary.toUpdate).toBe(1);
    expect(result.summary.toCreate).toBe(0);
  });

  it('preserves fields the sheet cannot express, rather than wiping them', () => {
    // A spreadsheet has no column for spec tables. An import that blanked them
    // would destroy work done in the admin every time a price list is re-imported.
    const existing = existingProduct('anker-cable');
    const result = plan(
      [['A-1', 'Anker Cable', '19.00', '', 'active', '', '', '', '']],
      [existing],
    );

    expect(result.products[0]?.product.specs).toEqual(existing.specs);
    expect(result.products[0]?.product.createdAt).toEqual(existing.createdAt);
    expect(result.products[0]?.product.updatedAt).toEqual(NOW);
  });

  it('defaults status to draft when the column is blank', () => {
    const result = plan([['A-1', 'Anker Cable', '19.00', '', '', '', '', '', '']]);
    expect(result.products[0]?.product.status).toBe('draft');
  });

  it('skips a wholly empty row without calling it an error', () => {
    const result = plan([
      ['A-1', 'Anker Cable', '19.00', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', ''],
      ['B-1', 'Logitech Mouse', '29.00', '', '', '', '', '', ''],
    ]);

    expect(result.products).toHaveLength(2);
    expect(result.rowProblems).toEqual([]);
  });

  describe('rejections', () => {
    it('reports a missing price against the row, and keeps going', () => {
      const result = plan([
        ['A-1', 'Anker Cable', '', '', '', '', '', '', ''],
        ['B-1', 'Logitech Mouse', '29.00', '', '', '', '', '', ''],
      ]);

      expect(result.rowProblems).toHaveLength(1);
      expect(result.rowProblems[0]?.row).toBe(2);
      expect(result.rowProblems[0]?.field).toBe('price');
      // One bad row must not cost the operator the other 399.
      expect(result.products).toHaveLength(1);
      expect(result.summary.rowsRejected).toBe(1);
    });

    it('reports EVERY problem in a row, not just the first', () => {
      const result = plan([['', '', 'free', '', '', '', '', '', '']]);
      const fields = result.rowProblems.map((problem) => problem.field).sort();
      expect(fields).toEqual(['price', 'sku', 'titleEn']);
    });

    it('rejects an ambiguous date and names the row', () => {
      const result = plan([['A-1', 'Anker Cable', '19.00', '', '', '', '', '25.00', '03/04/2026']]);
      const problem = result.rowProblems.find((p) => p.field === 'offerEndsAt');
      expect(problem?.problem.tag).toBe('ambiguous_date');
      expect(problem?.row).toBe(2);
    });

    it('reports an offer date that has already passed, and still imports the row', () => {
      /*
       * The domain CLEARS an expired offer rather than refusing the product, so
       * a mistyped year — 2025 where 2026 was meant — would otherwise vanish
       * silently as a discount that never appeared. This is the only place it
       * can be caught with a row number attached.
       */
      const result = plan([['A-1', 'Anker Cable', '19.00', '', '', '', '', '25.00', '2026-01-01']]);

      const problem = result.rowProblems.find((p) => p.field === 'offerEndsAt');
      expect(problem?.problem.tag).toBe('date_already_past');
      expect(problem?.row).toBe(2);

      // Reported, not rejected: the product still arrives, without the offer.
      expect(result.products).toHaveLength(1);
      expect(result.products[0]?.product.variants[0]?.compareAtPrice).toBeNull();
    });

    it('says nothing about an offer date still in the future', () => {
      const result = plan([['A-1', 'Anker Cable', '19.00', '', '', '', '', '25.00', '2026-12-31']]);
      expect(result.rowProblems.filter((p) => p.field === 'offerEndsAt')).toEqual([]);
    });

    it('rejects a duplicated SKU and points at the row that claimed it first', () => {
      const result = plan([
        ['SAME', 'Anker Cable', '19.00', '', '', '', '', '', ''],
        ['SAME', 'Logitech Mouse', '29.00', '', '', '', '', '', ''],
      ]);

      const problem = result.rowProblems.find((p) => p.field === 'sku');
      expect(problem?.row).toBe(3);
      if (problem?.problem.tag === 'duplicate_sku') {
        expect(problem.problem.firstSeenAtRow).toBe(2);
      }
      expect(result.products).toHaveLength(1);
    });

    it('reports a domain rejection with the rows responsible', () => {
      // A compare-at price with no end date is rejected by the domain because
      // consumer protection law requires every offer to carry an expiry.
      const result = plan([['A-1', 'Anker Cable', '19.00', '', 'active', '', '', '25.00', '']]);

      expect(result.products).toEqual([]);
      expect(result.productProblems).toHaveLength(1);
      expect(result.productProblems[0]?.rows).toEqual([2]);
      expect(result.productProblems[0]?.reason.tag).toBe('offer_without_end_date');
    });

    it('reports an inconsistent variant matrix against the whole group', () => {
      const result = plan([
        ['IP3-BLK', 'Lenovo IdeaPad 3', '1199.00', '', '', 'Colour', 'Black', '', ''],
        // Second row declares no option at all, so the matrix does not line up.
        ['IP3-SLV', 'Lenovo IdeaPad 3', '1249.00', '', '', '', '', '', ''],
      ]);

      expect(result.products).toEqual([]);
      expect(result.productProblems[0]?.rows).toEqual([2, 3]);
      expect(result.productProblems[0]?.reason.tag).toBe('variant_options_mismatch');
    });

    it('stops before parsing anything when a required column is unmapped', () => {
      const result = plan(
        [['Anker Cable', '19.00']],
        [],
        ['Title', 'Price'], // no SKU column
      );

      expect(result.mappingProblems.map((p) => p.field)).toEqual(['sku']);
      expect(result.products).toEqual([]);
      // Every row is unusable, and saying so up front beats 400 identical errors.
      expect(result.summary.rowsRejected).toBe(1);
    });
  });

  describe('the plan is a dry run', () => {
    it('reports a summary that adds up', () => {
      const result = plan([
        ['A-1', 'Anker Cable', '19.00', '', '', '', '', '', ''],
        ['B-1', 'Logitech Mouse', '', '', '', '', '', '', ''],
        ['C-1', 'Dell Monitor', '199.00', '', '', '', '', '', ''],
      ]);

      expect(result.summary.dataRows).toBe(3);
      expect(result.summary.products).toBe(2);
      expect(result.summary.toCreate).toBe(2);
      expect(result.summary.rowsRejected).toBe(1);
    });

    it('produces products that already satisfy every domain invariant', () => {
      // Everything in plan.products is a validated Product, so committing cannot
      // fail validation later — the preview is the truth.
      const result = plan([['A-1', 'Anker Cable', '19.00', 'Anker', 'active', '', '', '', '']]);
      const product = result.products[0]?.product;
      expect(product?.title.en).toBe('Anker Cable');
      expect(product?.variants[0]?.price.cents).toBe(1900);
      expect(product?.storeId).toBe('taz4tech');
    });
  });

  it('gives an image alt text so the product page cannot inherit a WCAG failure', () => {
    const headers = [...HEADERS, 'Image Src'];
    const result = plan(
      [['A-1', 'Anker Cable', '19.00', '', '', '', '', '', '', '/media/a.webp']],
      [],
      headers,
    );

    const media = result.products[0]?.product.media[0];
    expect(media?.url).toBe('/media/a.webp');
    expect(media?.alt.en).toBe('Anker Cable');
  });

  it('collects distinct images across the rows of one product', () => {
    const headers = [...HEADERS, 'Image Src'];
    const result = plan(
      [
        ['IP3-BLK', 'Lenovo IdeaPad 3', '1199.00', '', '', 'Colour', 'Black', '', '', '/a.webp'],
        ['IP3-SLV', 'Lenovo IdeaPad 3', '1249.00', '', '', 'Colour', 'Silver', '', '', '/b.webp'],
        ['IP3-RED', 'Lenovo IdeaPad 3', '1259.00', '', '', 'Colour', 'Red', '', '', '/a.webp'],
      ],
      [],
      headers,
    );

    expect(result.products[0]?.product.media.map((m) => m.url)).toEqual(['/a.webp', '/b.webp']);
  });
});
