import { describe, expect, it } from 'vitest';
import { createIdGenerator, formatOrderNumber, isEntityId, parseOrderNumber } from './index';

describe('createIdGenerator', () => {
  it('produces 26-character Crockford base32 ids', () => {
    const ids = createIdGenerator();
    const id = ids.next();
    expect(id).toHaveLength(26);
    expect(isEntityId(id)).toBe(true);
  });

  it('never produces the ambiguous characters I, L, O or U', () => {
    const ids = createIdGenerator();
    for (let i = 0; i < 200; i++) {
      expect(ids.next()).not.toMatch(/[ILOU]/);
    }
  });

  it('produces unique ids within the same millisecond', () => {
    const ids = createIdGenerator(() => 1_700_000_000_000);
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(ids.next());
    expect(seen.size).toBe(1000);
  });

  it('sorts lexicographically by creation time, which is what keeps _id a usable index', () => {
    let clock = 1_700_000_000_000;
    const ids = createIdGenerator(() => clock);
    const earlier = ids.next();
    clock += 1000;
    const later = ids.next();
    expect(earlier < later).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isEntityId('')).toBe(false);
    expect(isEntityId('too-short')).toBe(false);
    expect(isEntityId(42)).toBe(false);
    expect(isEntityId(null)).toBe(false);
    // Right length, but contains an excluded letter.
    expect(isEntityId('I'.repeat(26))).toBe(false);
  });
});

describe('order numbers', () => {
  it('is fixed width so invoices align', () => {
    expect(formatOrderNumber(2026, 42)).toBe('T4T-26-000042');
    expect(formatOrderNumber(2026, 1)).toBe('T4T-26-000001');
    expect(formatOrderNumber(2026, 999999)).toBe('T4T-26-999999');
  });

  it('pads a single-digit year', () => {
    expect(formatOrderNumber(2007, 5)).toBe('T4T-07-000005');
  });

  it('round-trips through the parser', () => {
    const parsed = parseOrderNumber(formatOrderNumber(2026, 42));
    expect(parsed).toEqual({ year: 2026, sequence: 42 });
  });

  it('accepts lower case and surrounding whitespace, as typed by a customer on the phone', () => {
    expect(parseOrderNumber('  t4t-26-000042 ')).toEqual({ year: 2026, sequence: 42 });
  });

  it('returns null rather than throwing on anything else', () => {
    expect(parseOrderNumber('')).toBeNull();
    expect(parseOrderNumber('T4T-2026-42')).toBeNull();
    expect(parseOrderNumber('XXX-26-000042')).toBeNull();
    expect(parseOrderNumber('T4T-26-42')).toBeNull();
  });
});
