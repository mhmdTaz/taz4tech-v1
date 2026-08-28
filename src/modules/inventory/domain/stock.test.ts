import { describe, expect, it } from 'vitest';
import {
  availabilityOf,
  canTake,
  countToShow,
  createStockLevel,
  MAX_ON_HAND,
  type StockLevel,
} from './stock';

const NOW = new Date('2026-08-27T10:00:00Z');

const level = (overrides: Partial<StockLevel> = {}): StockLevel => ({
  storeId: 'taz4tech',
  sku: 'SKU-1',
  policy: 'tracked',
  onHand: 5,
  updatedAt: NOW,
  ...overrides,
});

const created = (overrides: Partial<StockLevel> = {}) => {
  const result = createStockLevel(level(overrides));
  if (!result.ok) throw new Error(`expected a valid level, got ${result.error.tag}`);
  return result.value;
};

describe('createStockLevel', () => {
  it('accepts a tracked level', () => {
    expect(created({ onHand: 5 })).toMatchObject({ policy: 'tracked', onHand: 5 });
  });

  it('accepts zero, which is a real answer', () => {
    // Out of stock is a state to record, not an error to refuse.
    expect(created({ onHand: 0 }).onHand).toBe(0);
  });

  it('trims the SKU', () => {
    expect(created({ sku: '  SKU-1  ' }).sku).toBe('SKU-1');
  });

  it('rejects a blank SKU', () => {
    expect(createStockLevel(level({ sku: '   ' }))).toEqual({
      ok: false,
      error: { tag: 'sku_empty' },
    });
  });

  it('rejects a fractional quantity', () => {
    // Half a laptop is a data-entry error, not a stock level.
    expect(createStockLevel(level({ onHand: 1.5 }))).toEqual({
      ok: false,
      error: { tag: 'quantity_not_a_whole_number', onHand: 1.5 },
    });
  });

  it('rejects a negative quantity', () => {
    expect(createStockLevel(level({ onHand: -1 }))).toEqual({
      ok: false,
      error: { tag: 'quantity_negative', onHand: -1 },
    });
  });

  it('rejects an absurd quantity, which is an extra zero', () => {
    expect(createStockLevel(level({ onHand: MAX_ON_HAND + 1 }))).toEqual({
      ok: false,
      error: { tag: 'quantity_absurd', onHand: MAX_ON_HAND + 1 },
    });
  });

  it('accepts exactly the ceiling', () => {
    expect(created({ onHand: MAX_ON_HAND }).onHand).toBe(MAX_ON_HAND);
  });

  it('zeroes the count on an untracked SKU', () => {
    // A stale number on something nobody counts reads as stock to anything that
    // looks at onHand without checking policy first — and something eventually
    // will.
    expect(created({ policy: 'untracked', onHand: 99 }).onHand).toBe(0);
  });

  it('still refuses a bad quantity on an untracked SKU', () => {
    // Zeroing it afterwards would otherwise hide a typo the operator should see.
    expect(createStockLevel(level({ policy: 'untracked', onHand: -5 })).ok).toBe(false);
  });
});

describe('availabilityOf', () => {
  it('treats no record as in stock, not as out of it', () => {
    // The default that keeps an imported catalogue buyable: a SKU nobody counts
    // is not a SKU that ran out.
    expect(availabilityOf(null)).toBe('in_stock');
  });

  it('treats an untracked SKU as in stock', () => {
    expect(availabilityOf(created({ policy: 'untracked' }))).toBe('in_stock');
  });

  it('is in stock while units remain', () => {
    expect(availabilityOf(created({ onHand: 1 }))).toBe('in_stock');
  });

  it('is out of stock at zero', () => {
    expect(availabilityOf(created({ onHand: 0 }))).toBe('out_of_stock');
  });
});

describe('canTake', () => {
  it('allows a quantity that is on hand', () => {
    expect(canTake(created({ onHand: 5 }), 5)).toBe(true);
  });

  it('refuses one more than is on hand', () => {
    // The whole reason stock exists: this is the line between selling the last
    // unit once and selling it twice.
    expect(canTake(created({ onHand: 5 }), 6)).toBe(false);
  });

  it('allows any quantity of an untracked SKU', () => {
    expect(canTake(created({ policy: 'untracked' }), 999)).toBe(true);
    expect(canTake(null, 999)).toBe(true);
  });

  it('allows a quantity of exactly one, which is most of them', () => {
    // Every other test here passes 1 only in cases that must REFUSE, so the
    // lower bound could become `< 2` with all of them still green — and the
    // commonest request in the shop, one of something, would stop working.
    expect(canTake(created({ onHand: 5 }), 1)).toBe(true);
    expect(canTake(created({ onHand: 1 }), 1)).toBe(true);
    expect(canTake(null, 1)).toBe(true);
  });

  it('refuses zero and negative quantities', () => {
    // "Take none" is not a request to satisfy; it is a caller with a bug.
    expect(canTake(created(), 0)).toBe(false);
    expect(canTake(created(), -1)).toBe(false);
    expect(canTake(null, 0)).toBe(false);
  });

  it('refuses a fractional quantity', () => {
    expect(canTake(created(), 1.5)).toBe(false);
    expect(canTake(null, 1.5)).toBe(false);
  });

  it('refuses anything from a tracked SKU at zero', () => {
    expect(canTake(created({ onHand: 0 }), 1)).toBe(false);
  });
});

describe('countToShow', () => {
  it('gives the number for a tracked SKU', () => {
    expect(countToShow(created({ onHand: 3 }))).toBe(3);
  });

  it('gives zero for a tracked SKU that has run out', () => {
    expect(countToShow(created({ onHand: 0 }))).toBe(0);
  });

  it('gives nothing for an untracked SKU', () => {
    // "In stock (0)" for something the shop simply has is worse than saying
    // nothing, and a made-up number is worse again.
    expect(countToShow(created({ policy: 'untracked' }))).toBeNull();
  });

  it('gives nothing when there is no record', () => {
    expect(countToShow(null)).toBeNull();
  });
});
