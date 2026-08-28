import { englishOnly } from '@platform/locale';
import { describe, expect, it } from 'vitest';
import {
  COLLECTION_SORTS,
  COLLECTION_STATUSES,
  type Collection,
  compareForNavigation,
  createCollection,
  hasRules,
  isFullyCurated,
  isPublished,
} from './collection';
import type { ProductId } from './product';

const NOW = new Date('2026-08-27T10:00:00Z');
const pid = (n: number) => `PRODUCT${String(n).padStart(19, '0')}` as ProductId;

const collection = (overrides: Partial<Collection> = {}): Collection => ({
  storeId: 'taz4tech',
  id: 'COLLECTION000000000000AAA',
  slug: 'laptops',
  title: englishOnly('Laptops'),
  description: englishOnly('Every laptop we sell.'),
  status: 'active',
  rules: { brands: ['Lenovo'] },
  pinnedProductIds: [],
  sort: 'newest',
  position: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('createCollection', () => {
  it('accepts a rule-based collection', () => {
    expect(createCollection(collection()).ok).toBe(true);
  });

  it('accepts a fully curated collection with no rules', () => {
    const result = createCollection(collection({ rules: {}, pinnedProductIds: [pid(1), pid(2)] }));
    expect(result.ok).toBe(true);
  });

  it('rejects a collection that can never contain anything', () => {
    // Neither rules nor pinned products. Publishing it means the shop offers
    // navigation that leads to an empty page, which reads as a broken site
    // rather than an empty category.
    const result = createCollection(collection({ rules: {}, pinnedProductIds: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('no_membership');
  });

  it('rejects an invalid slug', () => {
    const result = createCollection(collection({ slug: 'Not A Slug' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('slug_invalid');
  });

  it('rejects an empty title or description', () => {
    const noTitle = createCollection(collection({ title: { en: '' } }));
    expect(noTitle.ok).toBe(false);
    if (!noTitle.ok) expect(noTitle.error.tag).toBe('title_invalid');

    const noDescription = createCollection(collection({ description: { en: '  ' } }));
    expect(noDescription.ok).toBe(false);
    if (!noDescription.ok) expect(noDescription.error.tag).toBe('description_invalid');
  });

  it('trims the title', () => {
    const result = createCollection(collection({ title: { en: '  Laptops  ' } }));
    if (result.ok) expect(result.value.title.en).toBe('Laptops');
  });

  describe('rules', () => {
    it('rejects a blank brand', () => {
      const result = createCollection(collection({ rules: { brands: ['Lenovo', '  '] } }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('brand_empty');
    });

    it('rejects an option with no name', () => {
      const result = createCollection(
        collection({ rules: { options: [{ name: ' ', values: ['Black'] }] } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('option_name_empty');
    });

    it('rejects an option with no values', () => {
      // Selecting everything on an axis is the same as no rule, but it reads in
      // the admin as a filter that is switched on.
      const result = createCollection(
        collection({ rules: { options: [{ name: 'Colour', values: [] }] } }),
      );
      // Asserted whole rather than through `if (result.error.tag === ...)`,
      // which asserts NOTHING when the tag is wrong — the guard is false and the
      // body never runs. The name is what the admin screen puts in the message.
      expect(result).toEqual({ ok: false, error: { tag: 'option_values_empty', name: 'Colour' } });
    });

    it('rejects a blank option value', () => {
      const result = createCollection(
        collection({ rules: { options: [{ name: 'Colour', values: ['  '] }] } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('option_values_empty');
    });

    it('accepts a valid option rule', () => {
      const result = createCollection(
        collection({ rules: { options: [{ name: 'Colour', values: ['Black'] }] } }),
      );
      expect(result.ok).toBe(true);
    });

    it('rejects a negative price bound', () => {
      for (const rules of [{ priceMinCents: -1 }, { priceMaxCents: -1 }]) {
        const result = createCollection(collection({ rules }));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.tag).toBe('price_negative');
      }
    });

    it('rejects a reversed price range', () => {
      const result = createCollection(
        collection({ rules: { priceMinCents: 5000, priceMaxCents: 1000 } }),
      );
      // Both bounds are carried back so the admin can say which pair is wrong.
      expect(result).toEqual({
        ok: false,
        error: { tag: 'price_range_reversed', minCents: 5000, maxCents: 1000 },
      });
    });

    it('accepts an open-ended price rule', () => {
      expect(createCollection(collection({ rules: { priceMinCents: 1000 } })).ok).toBe(true);
      expect(createCollection(collection({ rules: { priceMaxCents: 1000 } })).ok).toBe(true);
    });

    it('accepts a price range with both bounds set', () => {
      // Every other price test sets ONE bound, which leaves the comparison
      // between them — the only thing `price_range_reversed` is about —
      // unexercised by anything that is supposed to pass.
      expect(
        createCollection(collection({ rules: { priceMinCents: 1000, priceMaxCents: 5000 } })).ok,
      ).toBe(true);
    });

    it('accepts a range whose bounds are equal, which selects one price', () => {
      expect(
        createCollection(collection({ rules: { priceMinCents: 5000, priceMaxCents: 5000 } })).ok,
      ).toBe(true);
    });

    it.each([
      ['priceMinCents', { priceMinCents: 0 }],
      ['priceMaxCents', { priceMaxCents: 0 }],
    ])('accepts a %s of exactly zero, which is free rather than negative', (_field, rules) => {
      expect(createCollection(collection({ rules })).ok).toBe(true);
    });
  });

  describe('pinned products', () => {
    it('accepts a list of distinct ids', () => {
      const result = createCollection(collection({ pinnedProductIds: [pid(1), pid(2), pid(3)] }));
      expect(result.ok).toBe(true);
    });

    it('rejects a duplicate, which would render the product twice', () => {
      const result = createCollection(collection({ pinnedProductIds: [pid(1), pid(1)] }));
      expect(result).toEqual({
        ok: false,
        error: { tag: 'pinned_duplicated', productId: pid(1) },
      });
    });
  });

  describe('position', () => {
    it('accepts zero and any positive integer', () => {
      expect(createCollection(collection({ position: 0 })).ok).toBe(true);
      expect(createCollection(collection({ position: 12 })).ok).toBe(true);
    });

    it.each([-1, 1.5, Number.NaN])('rejects a position of %s', (position) => {
      const result = createCollection(collection({ position }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('position_invalid');
    });
  });
});

describe('hasRules', () => {
  it('is false for no rules at all', () => {
    expect(hasRules({})).toBe(false);
    expect(hasRules({ brands: [], options: [] })).toBe(false);
  });

  it('is true for any single rule', () => {
    expect(hasRules({ brands: ['Lenovo'] })).toBe(true);
    expect(hasRules({ options: [{ name: 'Colour', values: ['Black'] }] })).toBe(true);
    expect(hasRules({ priceMinCents: 100 })).toBe(true);
    expect(hasRules({ priceMaxCents: 100 })).toBe(true);
  });

  it('counts a zero lower bound as a rule', () => {
    // 0 is falsy; treating it as "no rule" would silently drop a deliberate
    // "from free" collection.
    expect(hasRules({ priceMinCents: 0 })).toBe(true);
  });
});

describe('reading a collection', () => {
  it('is published only when active', () => {
    expect(isPublished(collection({ status: 'active' }))).toBe(true);
    expect(isPublished(collection({ status: 'draft' }))).toBe(false);
    expect(isPublished(collection({ status: 'archived' }))).toBe(false);
  });

  it('knows a fully curated collection from a rule-based one', () => {
    expect(isFullyCurated(collection({ rules: {}, pinnedProductIds: [pid(1)] }))).toBe(true);
    expect(isFullyCurated(collection({ rules: { brands: ['Lenovo'] } }))).toBe(false);
  });

  it('orders navigation by position, breaking ties by title', () => {
    const first = collection({ position: 0, title: englishOnly('Zebra') });
    const second = collection({ position: 1, title: englishOnly('Apple') });
    expect(compareForNavigation(first, second)).toBeLessThan(0);

    const tieA = collection({ position: 5, title: englishOnly('Apple') });
    const tieB = collection({ position: 5, title: englishOnly('Zebra') });
    // A stable tiebreak, so navigation does not reshuffle between requests.
    expect(compareForNavigation(tieA, tieB)).toBeLessThan(0);
    expect(compareForNavigation(tieB, tieA)).toBeGreaterThan(0);
  });

  it('knows every status and sort', () => {
    expect([...COLLECTION_STATUSES]).toEqual(['draft', 'active', 'archived']);
    expect([...COLLECTION_SORTS]).toEqual(['newest', 'price-asc', 'price-desc', 'manual']);
  });
});
