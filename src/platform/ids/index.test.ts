import { describe, expect, it } from 'vitest';
import {
  createIdGenerator,
  createViewToken,
  formatOrderNumber,
  isEntityId,
  isViewToken,
  parseOrderNumber,
} from './index';

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

describe('createViewToken', () => {
  it('is 26 Crockford characters, like an id', () => {
    expect(isViewToken(createViewToken())).toBe(true);
  });

  it('carries no timestamp, which is the whole reason it is not an id', () => {
    /*
     * Ids are sortable because their first ten characters are the clock — so
     * two generated back to back share a prefix. A token that did the same
     * would hand an attacker who knows roughly when an order was placed ten
     * characters for free.
     */
    const sharedPrefix = (a: string, b: string) => {
      let n = 0;
      while (n < a.length && a[n] === b[n]) n += 1;
      return n;
    };

    const ids = Array.from({ length: 20 }, () => createIdGenerator().next());
    const tokens = Array.from({ length: 20 }, createViewToken);

    // Every id generated in the same millisecond agrees for ten characters.
    expect(Math.min(...ids.slice(1).map((id) => sharedPrefix(ids[0] ?? '', id)))).toBeGreaterThan(
      5,
    );
    // No two tokens should agree on more than a character or two by luck.
    expect(
      Math.max(...tokens.slice(1).map((token) => sharedPrefix(tokens[0] ?? '', token))),
    ).toBeLessThan(5);
  });

  it('does not repeat', () => {
    const many = Array.from({ length: 500 }, createViewToken);
    expect(new Set(many).size).toBe(many.length);
  });

  it('refuses anything that is not the right shape', () => {
    // I and L and O and U are not in the alphabet: they are the characters
    // people misread, which is the point of Crockford.
    for (const bad of ['', 'abc', 'I'.repeat(26), 'U'.repeat(26), `${createViewToken()}0`]) {
      expect(isViewToken(bad), bad).toBe(false);
    }
  });
});
