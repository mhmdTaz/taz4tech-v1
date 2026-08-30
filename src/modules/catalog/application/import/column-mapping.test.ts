import { describe, expect, it } from 'vitest';
import {
  detectMapping,
  IMPORT_FIELDS,
  type ImportField,
  normaliseHeader,
  REQUIRED_FIELDS,
  validateMapping,
} from './column-mapping';

describe('normaliseHeader', () => {
  it.each([
    ['Compare-at Price', 'compareatprice'],
    ['  SKU  ', 'sku'],
    ['Variant Price', 'variantprice'],
    ['Option1 Name', 'option1name'],
  ])('normalises %s', (input, expected) => {
    expect(normaliseHeader(input)).toBe(expected);
  });
});

/**
 * Every header spelling the importer claims to recognise, written out.
 *
 * NOT read from HEADER_ALIASES, and that is the whole point. A test that loops
 * over the table it is testing passes just as happily when a spelling is wrong,
 * because the expectation moves with the code — the same trap that let a
 * five-megabyte upload cap be asserted as MAX_BYTES and survive being changed
 * to five bytes.
 *
 * So this is a second, independent copy. Changing an alias means changing it
 * here too, deliberately, which is the point at which somebody asks whether the
 * supplier sheet that needed it still exists.
 *
 * Mutation testing found the gap: sixty-nine of these spellings were never
 * exercised, and six fields — descriptionAr, descriptionFr, barcode,
 * weightGrams and both option-2 columns — had their ENTIRE alias list
 * replaceable with [] without a single test noticing.
 */
const EXPECTED_ALIASES: readonly (readonly [ImportField, readonly string[]])[] = [
  ['slug', ['slug', 'handle', 'urlkey', 'url']],
  ['titleEn', ['titleen', 'title', 'productname', 'name', 'product']],
  ['titleAr', ['titlear', 'arabictitle', 'namear', 'arabicname']],
  ['titleFr', ['titlefr', 'frenchtitle', 'namefr', 'frenchname']],
  ['descriptionEn', ['descriptionen', 'bodyhtml', 'longdescription', 'details']],
  ['descriptionAr', ['descriptionar', 'arabicdescription']],
  ['descriptionFr', ['descriptionfr', 'frenchdescription']],
  ['brand', ['brand', 'vendor', 'manufacturer', 'make']],
  ['status', ['status', 'published', 'active']],
  ['sku', ['sku', 'variantsku', 'itemcode', 'itemnumber', 'partnumber', 'mpn', 'code']],
  ['compareAtPrice', ['compareatprice', 'compareprice', 'wasprice', 'rrp', 'listprice', 'msrp']],
  ['price', ['price', 'variantprice', 'sellingprice', 'unitprice', 'retailprice']],
  ['offerEndsAt', ['offerendsat', 'offerend', 'saleends', 'promotionends', 'validuntil']],
  ['barcode', ['barcode', 'ean', 'upc', 'gtin']],
  ['weightGrams', ['weightgrams', 'weightg', 'grams', 'weight']],
  ['option1Name', ['option1name', 'optionname1', 'attribute1name']],
  ['option1Value', ['option1value', 'optionvalue1', 'attribute1value']],
  ['option2Name', ['option2name', 'optionname2', 'attribute2name']],
  ['option2Value', ['option2value', 'optionvalue2', 'attribute2value']],
  ['imageUrl', ['imageurl', 'imagesrc', 'image', 'photo', 'picture']],
  ['imageAlt', ['imagealt', 'imagealttext', 'alt', 'alttext']],
  ['stock', ['stock', 'quantity', 'qty', 'onhand', 'stocklevel', 'inventory', 'available']],
];

describe('the header spellings it recognises', () => {
  it.each(EXPECTED_ALIASES.flatMap(([field, aliases]) => aliases.map((alias) => [alias, field])))(
    'reads a column headed "%s" as %s',
    (alias, field) => {
      // One header, so nothing else can claim the column: this asserts the
      // alias belongs to this field and to no other.
      expect(detectMapping([alias as string])[field as ImportField]).toBe(0);
    },
  );

  it('covers every field the importer can map', () => {
    // A field added to IMPORT_FIELDS without spellings here would otherwise be
    // undetectable and untested at the same time.
    expect(EXPECTED_ALIASES.map(([field]) => field).sort()).toEqual([...IMPORT_FIELDS].sort());
  });

  it('gives no spelling to two different fields', () => {
    /*
     * The invariant the claim-tracking rests on.
     *
     * detectMapping refuses to hand one column to two fields, and with no
     * shared spelling that guard can never fire — a header matches at most one
     * alias, so at most one field wants it. Add "price" to compareAtPrice and
     * it fires immediately, which is the day this test tells you to go and
     * read it rather than the day a Shopify import prices everything at its
     * was-price.
     */
    const seen = new Map<string, ImportField>();
    for (const [field, aliases] of EXPECTED_ALIASES) {
      for (const alias of aliases) {
        expect(seen.get(alias), `"${alias}" is claimed by ${seen.get(alias)} and ${field}`).toBe(
          undefined,
        );
        seen.set(alias, field);
      }
    }
  });
});

describe('detectMapping', () => {
  it('detects a plain sheet', () => {
    const mapping = detectMapping(['SKU', 'Name', 'Price', 'Brand']);
    expect(mapping).toEqual({ sku: 0, titleEn: 1, price: 2, brand: 3 });
  });

  it('detects a Shopify-style export', () => {
    const mapping = detectMapping([
      'Handle',
      'Title',
      'Vendor',
      'Option1 Name',
      'Option1 Value',
      'Variant SKU',
      'Variant Price',
      'Image Src',
    ]);
    expect(mapping.slug).toBe(0);
    expect(mapping.titleEn).toBe(1);
    expect(mapping.brand).toBe(2);
    expect(mapping.option1Name).toBe(3);
    expect(mapping.option1Value).toBe(4);
    expect(mapping.sku).toBe(5);
    expect(mapping.price).toBe(6);
    expect(mapping.imageUrl).toBe(7);
  });

  it('gives "Compare at price" to compareAtPrice and leaves "Price" as the selling price', () => {
    // Resolved the other way round, every Shopify import would land the was-price
    // in the price column and sell everything at the higher number.
    const mapping = detectMapping(['SKU', 'Price', 'Compare At Price']);
    expect(mapping.price).toBe(1);
    expect(mapping.compareAtPrice).toBe(2);
  });

  it('never assigns one column to two fields', () => {
    // With only "Price" present, compareAtPrice must stay unmapped rather than
    // claim the same column and make every product look permanently discounted.
    const mapping = detectMapping(['SKU', 'Name', 'Price']);
    expect(mapping.price).toBe(2);
    expect(mapping.compareAtPrice).toBeUndefined();

    const indices = Object.values(mapping);
    expect(new Set(indices).size).toBe(indices.length);
  });

  it('does not mistake a description column for the title', () => {
    const mapping = detectMapping(['SKU', 'Product Name', 'Description EN', 'Price']);
    expect(mapping.titleEn).toBe(1);
    expect(mapping.descriptionEn).toBe(2);
  });

  it('detects locale-specific titles ahead of the bare one', () => {
    const mapping = detectMapping(['SKU', 'Price', 'Title', 'Title AR', 'Title FR']);
    expect(mapping.titleEn).toBe(2);
    expect(mapping.titleAr).toBe(3);
    expect(mapping.titleFr).toBe(4);
  });

  it('is case and punctuation insensitive', () => {
    expect(detectMapping(['s.k.u.', 'PRICE', 'na me']).sku).toBe(0);
    expect(detectMapping(['s.k.u.', 'PRICE', 'na me']).price).toBe(1);
  });

  it('returns an empty mapping for headers it does not recognise', () => {
    expect(detectMapping(['col a', 'col b'])).toEqual({});
  });

  it('handles an empty header row', () => {
    expect(detectMapping([])).toEqual({});
  });
});

describe('validateMapping', () => {
  it('passes when every required field is mapped', () => {
    expect(validateMapping({ titleEn: 0, sku: 1, price: 2 })).toEqual([]);
  });

  it('names each missing required field', () => {
    const problems = validateMapping({ titleEn: 0 });
    expect(problems.map((p) => p.field).sort()).toEqual(['price', 'sku']);
    for (const problem of problems) expect(problem.tag).toBe('missing_required_field');
  });

  it('requires exactly title, sku and price — nothing else blocks an import', () => {
    // Everything else has a defensible default. A brand-less product is a
    // product; a price-less row is a guess.
    expect([...REQUIRED_FIELDS].sort()).toEqual(['price', 'sku', 'titleEn']);
    expect(validateMapping({})).toHaveLength(3);
  });
});
