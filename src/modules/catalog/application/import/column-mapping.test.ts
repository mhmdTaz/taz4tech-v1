import { describe, expect, it } from 'vitest';
import { detectMapping, normaliseHeader, REQUIRED_FIELDS, validateMapping } from './column-mapping';

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
