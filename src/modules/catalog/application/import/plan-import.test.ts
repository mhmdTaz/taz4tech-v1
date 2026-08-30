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

const plan = (
  rows: string[][],
  existing: Product[] = [],
  headers: string[] = HEADERS,
  now: Date = NOW,
) => {
  idCounter = 0;
  return planImport({
    rows: [headers, ...rows],
    mapping: detectMapping(headers),
    storeId: 'taz4tech',
    now,
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

  describe('every column the importer can read', () => {
    const WIDE = [
      'SKU',
      'Title',
      'Title AR',
      'Title FR',
      'Description EN',
      'Description AR',
      'Description FR',
      'Brand',
      'Barcode',
      'Weight Grams',
      'Price',
      'Image Src',
      'Image Alt',
    ];

    it('reads each optional column into its own field', () => {
      /*
       * One wide row, because the columns are read by name and a name that is
       * wrong reads nothing at all. Silently: the product imports, the field is
       * simply empty, and nobody notices until a customer opens a page with no
       * description on it.
       */
      const result = plan(
        [
          [
            'A-1',
            'Anker Cable',
            'كابل انكر',
            'Câble Anker',
            'Two metres.',
            'مترين.',
            'Deux mètres.',
            'Anker',
            '5901234123457',
            '250',
            '19.00',
            'https://s.example/a.png',
            'A black cable',
          ],
        ],
        [],
        WIDE,
      );

      expect(result.rowProblems).toEqual([]);
      const product = result.products[0]?.product;

      expect(product?.title).toMatchObject({
        en: 'Anker Cable',
        ar: 'كابل انكر',
        fr: 'Câble Anker',
      });
      expect(product?.description).toMatchObject({
        en: 'Two metres.',
        ar: 'مترين.',
        fr: 'Deux mètres.',
      });
      expect(product?.brand).toBe('Anker');
      expect(product?.variants[0]).toMatchObject({ barcode: '5901234123457', weightGrams: 250 });
      expect(product?.media[0]).toMatchObject({
        kind: 'image',
        url: 'https://s.example/a.png',
        alt: { en: 'A black cable' },
      });
    });

    it.each([
      ['compareAtPrice', 'Compare At Price', 'nonsense'],
      ['status', 'Status', 'maybe'],
      ['weightGrams', 'Weight Grams', 'heavy'],
      ['stock', 'Stock', 'lots'],
    ])('names %s when that column is the one that cannot be read', (field, header, bad) => {
      // The field on a problem is what the import report puts in front of the
      // operator. Name the wrong one and they go and fix a column that is fine.
      const headers = ['SKU', 'Title', 'Price', header];
      const result = plan([['A-1', 'Anker Cable', '19.00', bad]], [], headers);

      expect(result.rowProblems.map((problem) => problem.field)).toEqual([field]);
    });
  });

  describe('the option pair, the offer boundary and the missing image', () => {
    it('needs BOTH halves of an option, and says nothing when only one is filled', () => {
      // A name with no value is a column the sheet declares and this row does
      // not use, which is normal in a mixed catalogue. Treated as an option it
      // becomes a variant axis with an empty value, which the domain refuses.
      const headers = ['SKU', 'Title', 'Price', 'Option1 Name', 'Option1 Value'];
      const nameOnly = plan([['A-1', 'Anker Cable', '19.00', 'Length', '']], [], headers);
      const valueOnly = plan([['B-1', 'Anker Cable', '19.00', '', '2m']], [], headers);

      expect(nameOnly.rowProblems).toEqual([]);
      expect(nameOnly.products[0]?.product.variants[0]?.options).toEqual([]);
      expect(valueOnly.rowProblems).toEqual([]);
      expect(valueOnly.products[0]?.product.variants[0]?.options).toEqual([]);
    });

    it('reports an offer ending at exactly this moment as already past', () => {
      // The boundary. An offer whose expiry is now is over, not running — and
      // `<` instead of `<=` would import it as live for the length of a tick.
      const result = plan([
        ['A-1', 'Anker Cable', '19.00', '', '', '', '', '25.00', NOW.toISOString().slice(0, 10)],
      ]);

      expect(result.rowProblems.map((problem) => problem.field)).toContain('offerEndsAt');
    });

    it('plans a product with no image at all', () => {
      // The image column is optional, and reading `.url` off an absent one is
      // the difference between a plan and a thrown TypeError mid-import.
      const result = plan([['A-1', 'Anker Cable', '19.00', '', '', '', '', '', '']]);

      expect(result.rowProblems).toEqual([]);
      expect(result.products[0]?.product.media).toEqual([]);
    });
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

    it.each([
      ['titleEn', ['A-1', '', '19.00', '', '', '', '', '', '']],
      ['sku', ['', 'Anker Cable', '19.00', '', '', '', '', '', '']],
      ['status', ['A-1', 'Anker Cable', '19.00', '', 'maybe', '', '', '', '']],
    ])('produces no product from a row missing only %s', (_field, row) => {
      // Each required field on its own. Together they only prove that SOME
      // check fired; separately they prove which.
      const result = plan([row]);

      expect(result.rowProblems).not.toEqual([]);
      expect(result.products).toEqual([]);
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

      // Asserted whole, value included: the date the operator typed is what
      // makes the message actionable, and it is read back out of the cell by name.
      expect(result.rowProblems).toEqual([
        {
          row: 2,
          field: 'offerEndsAt',
          problem: { tag: 'date_already_past', value: '2026-01-01' },
        },
      ]);

      // Reported, not rejected: the product still arrives, without the offer.
      expect(result.products).toHaveLength(1);
      expect(result.products[0]?.product.variants[0]?.compareAtPrice).toBeNull();
    });

    it('reports an offer that ends at EXACTLY the moment asked about', () => {
      /*
       * A date cell carries no time, so it lands on midnight UTC — and an offer
       * that ends at midnight is over at midnight. `isOnOffer` wants strictly
       * later, so the domain clears this one; reported at the boundary or not at
       * all is the difference between the operator seeing why the discount
       * disappeared and watching it vanish.
       */
      const midnight = new Date('2026-08-27T00:00:00Z');
      const result = plan(
        [['A-1', 'Anker Cable', '19.00', '', '', '', '', '25.00', '2026-08-27']],
        [],
        HEADERS,
        midnight,
      );

      expect(result.rowProblems[0]?.problem).toEqual({
        tag: 'date_already_past',
        value: '2026-08-27',
      });
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

      // Asserted whole: `if (problem.tag === ...)` checks nothing when the tag
      // is wrong, which is exactly the case worth catching.
      expect(result.rowProblems).toEqual([
        { row: 3, field: 'sku', problem: { tag: 'duplicate_sku', firstSeenAtRow: 2 } },
      ]);
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
      // Both rows are gone, and the summary has to say so. Counting only the
      // row-level problems would report nothing rejected while nothing imported.
      expect(result.summary.rowsRejected).toBe(2);
    });

    it('stops before parsing anything when a required column is unmapped', () => {
      const result = plan(
        [['Anker Cable', '19.00']],
        [],
        ['Title', 'Price'], // no SKU column
      );

      expect(result.mappingProblems.map((p) => p.field)).toEqual(['sku']);
      expect(result.products).toEqual([]);
      // And it stopped: no row was parsed, so there is nothing else to report.
      // Without the early return the operator gets the same problem 400 times.
      expect(result.rowProblems).toEqual([]);
      expect(result.productProblems).toEqual([]);
      expect(result.skuConflicts).toEqual([]);
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

    it('counts each rejected row once, and every one of them', () => {
      // Two bad rows, and the count has to be two. Every other case here rejects
      // exactly one row, which is the count a summary that had lost the row
      // numbers altogether would also report.
      const result = plan([
        ['A-1', 'Anker Cable', '', '', '', '', '', '', ''],
        ['B-1', 'Logitech Mouse', '29.00', '', '', '', '', '', ''],
        ['C-1', 'Dell Monitor', '', '', '', '', '', '', ''],
      ]);

      expect(result.rowProblems.map((problem) => problem.row)).toEqual([2, 4]);
      expect(result.summary.rowsRejected).toBe(2);
      expect(result.summary.products).toBe(1);
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
