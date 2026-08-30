import { describe, expect, it } from 'vitest';
import {
  date,
  isBlank,
  money,
  optionalDate,
  optionalInteger,
  optionalMoney,
  optionalText,
  requiredText,
  status,
  text,
} from './parse-cell';

describe('blank handling', () => {
  it.each([undefined, '', '   ', '\t'])('treats %p as blank', (value) => {
    expect(isBlank(value)).toBe(true);
  });

  it('does not treat a zero as blank', () => {
    // "0" is a real weight and a real price. Treating it as absent would silently
    // drop data the sheet stated explicitly.
    expect(isBlank('0')).toBe(false);
  });

  it('optionalText returns null for blank and trims otherwise', () => {
    expect(optionalText('  ')).toBeNull();
    expect(optionalText('  Lenovo  ')).toBe('Lenovo');
  });

  it('text() turns a missing cell into an empty string', () => {
    // Columns the sheet simply does not have arrive as undefined, not ''.
    expect(text(undefined)).toBe('');
    expect(text('  padded  ')).toBe('padded');
  });

  it('requiredText reports an empty cell', () => {
    const result = requiredText('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('required_cell_empty');
  });
});

describe('money cells', () => {
  it.each([
    ['1299', 129900],
    ['1299.00', 129900],
    ['$1,299.99', 129999],
    ['1,299.99 USD', 129999],
    ['1299.99 usd', 129999],
    ['  19.00  ', 1900],
    ['0', 0],
  ])('parses %s', (input, cents) => {
    const result = money(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.cents).toBe(cents);
  });

  it('strips a currency suffix with no space before it', () => {
    // "1299.99usd" arrives from exports that concatenate rather than format.
    expect(money('1299.99usd')).toMatchObject({ ok: true, value: { cents: 129999 } });
  });

  it('strips the suffix only at the END, so a currency prefix is not silently dropped', () => {
    // "USD 1299" is a different cell from "1299 USD": one is a number with a
    // label after it, the other is text this parser has no business guessing at.
    expect(money('usd 1299').ok).toBe(false);
  });

  it('reports a blank cell as EMPTY rather than unparsable', () => {
    // Different sentence to whoever reads the import report: a column nobody
    // filled in is not the same problem as a price nobody can read.
    expect(money('   ')).toMatchObject({ ok: false, error: { tag: 'required_cell_empty' } });
  });

  it.each(['', 'free', 'N/A', '1.234', '12,34'])('rejects %p', (input) => {
    expect(money(input).ok).toBe(false);
  });

  it('reports the original cell text, not the cleaned one', () => {
    const result = money('about $12');
    expect(result).toMatchObject({
      ok: false,
      error: { tag: 'unparsable_money', value: 'about $12' },
    });
  });

  it('optionalMoney allows a blank cell', () => {
    const result = optionalMoney('');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });
});

describe('date cells', () => {
  it('accepts an ISO date', () => {
    const result = date('2026-12-01');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it.each(['03/04/2026', '3-4-2026', '03.04.2026'])(
    'refuses %s as ambiguous rather than guessing',
    (input) => {
      // 03/04 is 3 April in Beirut and 4 March in New York, and the file does not
      // say which. Guessing could set an offer expiry eight months wrong — on the
      // field consumer protection law requires to be accurate.
      const result = date(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('ambiguous_date');
    },
  );

  it('rejects a date that does not exist', () => {
    // Date() would silently roll 2026-02-31 into 3 March.
    const result = date('2026-02-31');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('unparsable_date');
  });

  it.each(['soon', '2026', '2026-13-01', 'Dec 1 2026'])('rejects %p', (input) => {
    expect(date(input)).toMatchObject({
      ok: false,
      error: { tag: 'unparsable_date', value: input },
    });
  });

  it.each(['valid until 03/04/2026', '03/04/2026 (approx)'])(
    'reads %p as unparsable, not ambiguous',
    (input) => {
      /*
       * The slashed pattern matches a WHOLE cell, not a date inside a sentence.
       * Unanchored it would call this ambiguous — which tells the operator to
       * rewrite a date that is not the problem, instead of that the cell is
       * prose.
       */
      expect(date(input)).toMatchObject({ ok: false, error: { tag: 'unparsable_date' } });
    },
  );

  it('reports a blank cell as empty rather than unparsable', () => {
    // date() is also callable directly, not only through optionalDate.
    const result = date('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('required_cell_empty');
  });

  it('optionalDate allows a blank cell', () => {
    const result = optionalDate('   ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });
});

describe('status cells', () => {
  it.each([
    ['active', 'active'],
    ['Published', 'active'],
    ['YES', 'active'],
    ['true', 'active'],
    ['1', 'active'],
    ['draft', 'draft'],
    ['unpublished', 'draft'],
    ['no', 'draft'],
    ['false', 'draft'],
    ['0', 'draft'],
    ['archived', 'archived'],
    ['inactive', 'archived'],
  ])('reads %s as %s', (input, expected) => {
    const result = status(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(expected);
  });

  it('defaults a blank cell to draft, never to active', () => {
    // The whole point: importing 400 rows must not publish 400 products to
    // customers because the sheet had no status column.
    const result = status(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('draft');
  });

  it('rejects a word it does not recognise instead of assuming', () => {
    const result = status('maybe');
    expect(result).toMatchObject({ ok: false, error: { tag: 'unknown_status', value: 'maybe' } });
  });
});

describe('integer cells', () => {
  it.each([
    ['1650', 1650],
    ['1,650', 1650],
    [' 60 ', 60],
    ['0', 0],
  ])('parses %s', (input, expected) => {
    const result = optionalInteger(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(expected);
  });

  it('allows a blank cell', () => {
    const result = optionalInteger('');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it.each(['1.5', '-4', 'heavy', '1e5000'])('rejects %p', (input) => {
    expect(optionalInteger(input).ok).toBe(false);
  });
});
