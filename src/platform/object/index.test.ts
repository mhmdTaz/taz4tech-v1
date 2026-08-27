import { describe, expect, it } from 'vitest';
import { compact } from './index';

describe('compact', () => {
  it('removes keys whose value is undefined', () => {
    expect(compact({ a: 1, b: undefined, c: 'x' })).toEqual({ a: 1, c: 'x' });
  });

  it('removes the KEY, not just the value', () => {
    // The whole point under exactOptionalPropertyTypes: `'b' in result` must be
    // false, not merely `result.b === undefined`.
    const result = compact({ a: 1, b: undefined });
    expect(Object.hasOwn(result, 'b')).toBe(false);
  });

  it('keeps null, which is a value someone chose', () => {
    // null means "explicitly nothing" in this codebase — a product with no
    // brand, a variant with no barcode. Dropping it would lose that decision.
    expect(compact({ a: null })).toEqual({ a: null });
    expect(Object.hasOwn(compact({ a: null }), 'a')).toBe(true);
  });

  it('keeps falsy values that are not undefined', () => {
    // 0 is a real price and '' is a real (if unusual) string; dropping either
    // would silently discard data.
    const result = compact({ zero: 0, empty: '', no: false });
    expect(result).toEqual({ zero: 0, empty: '', no: false });
  });

  it('returns an empty object unchanged', () => {
    expect(compact({})).toEqual({});
  });

  it('returns an empty object when every value is undefined', () => {
    expect(compact({ a: undefined, b: undefined })).toEqual({});
  });

  it('does not mutate its input', () => {
    const source = { a: 1, b: undefined };
    compact(source);
    expect(Object.hasOwn(source, 'b')).toBe(true);
  });

  it('does not recurse into nested objects', () => {
    // Shallow on purpose: a nested undefined is the caller's business, and
    // recursing would quietly rewrite values they built deliberately.
    const result = compact({ nested: { a: undefined } });
    expect(result).toEqual({ nested: { a: undefined } });
  });
});
