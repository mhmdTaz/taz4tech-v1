import { describe, expect, it } from 'vitest';
import {
  addToCart,
  type Cart,
  EMPTY_CART,
  formatCart,
  isEmpty,
  keepOnly,
  MAX_LINES,
  MAX_QUANTITY,
  parseCart,
  quantityOf,
  removeFromCart,
  setQuantity,
  totalItems,
} from './cart';

const cart = (...lines: [string, number][]): Cart => ({
  lines: lines.map(([sku, quantity]) => ({ sku, quantity })),
});

const added = (start: Cart, sku: string, quantity: number): Cart => {
  const result = addToCart(start, sku, quantity);
  if (!result.ok) throw new Error(`expected an add, got ${result.error.tag}`);
  return result.value;
};

describe('addToCart', () => {
  it('adds a line to an empty cart', () => {
    expect(added(EMPTY_CART, 'SKU-1', 2)).toEqual(cart(['SKU-1', 2]));
  });

  it('merges with a line that is already there', () => {
    // Two lines of one SKU would price correctly and read as a mistake, and the
    // customer would have to remove both to change their mind.
    expect(added(cart(['SKU-1', 2]), 'SKU-1', 3)).toEqual(cart(['SKU-1', 5]));
  });

  it('keeps distinct SKUs apart', () => {
    expect(added(cart(['SKU-1', 1]), 'SKU-2', 1)).toEqual(cart(['SKU-1', 1], ['SKU-2', 1]));
  });

  it('appends rather than reordering, so the cart does not shuffle', () => {
    const result = added(cart(['A', 1], ['B', 1]), 'C', 1);
    expect(result.lines.map((line) => line.sku)).toEqual(['A', 'B', 'C']);
  });

  it('keeps a merged line in its original position', () => {
    const result = added(cart(['A', 1], ['B', 1]), 'A', 1);
    expect(result.lines.map((line) => line.sku)).toEqual(['A', 'B']);
  });

  it('trims the SKU', () => {
    expect(added(EMPTY_CART, '  SKU-1  ', 1)).toEqual(cart(['SKU-1', 1]));
  });

  it('refuses a blank SKU', () => {
    expect(addToCart(EMPTY_CART, '   ', 1)).toEqual({ ok: false, error: { tag: 'sku_empty' } });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a quantity of %s, and says why',
    (quantity) => {
      /*
       * The TAG is asserted, not just `ok: false`. Mutation testing found that
       * every one of these passed with the error object emptied — so a caller
       * switching on `error.tag` to choose a message would have shown the
       * generic one with nothing failing.
       */
      expect(addToCart(EMPTY_CART, 'SKU-1', quantity)).toEqual({
        ok: false,
        error: { tag: 'quantity_out_of_range', quantity, max: MAX_QUANTITY },
      });
    },
  );

  it('accepts exactly the maximum', () => {
    expect(added(EMPTY_CART, 'SKU-1', MAX_QUANTITY).lines[0]?.quantity).toBe(MAX_QUANTITY);
  });

  it('REFUSES rather than clamping when a merge would pass the maximum', () => {
    // Silently capping would ship less than the customer asked for and say
    // nothing about it. The message names the limit so they can decide.
    expect(addToCart(cart(['SKU-1', MAX_QUANTITY - 1]), 'SKU-1', 5)).toEqual({
      ok: false,
      error: { tag: 'quantity_out_of_range', quantity: MAX_QUANTITY + 4, max: MAX_QUANTITY },
    });
  });

  it('refuses a new line past the line limit', () => {
    const full: Cart = {
      lines: Array.from({ length: MAX_LINES }, (_, i) => ({ sku: `SKU-${i}`, quantity: 1 })),
    };
    expect(addToCart(full, 'ONE-MORE', 1)).toEqual({
      ok: false,
      error: { tag: 'too_many_lines', max: MAX_LINES },
    });
  });

  it('still merges into a full cart, because that adds no line', () => {
    const full: Cart = {
      lines: Array.from({ length: MAX_LINES }, (_, i) => ({ sku: `SKU-${i}`, quantity: 1 })),
    };
    expect(addToCart(full, 'SKU-0', 1).ok).toBe(true);
  });

  it('does not mutate the cart it was given', () => {
    const original = cart(['SKU-1', 1]);
    added(original, 'SKU-1', 1);
    expect(original).toEqual(cart(['SKU-1', 1]));
  });
});

describe('setQuantity', () => {
  const set = (start: Cart, sku: string, quantity: number): Cart => {
    const result = setQuantity(start, sku, quantity);
    if (!result.ok) throw new Error(`expected a change, got ${result.error.tag}`);
    return result.value;
  };

  it('replaces a quantity outright rather than adding to it', () => {
    expect(set(cart(['SKU-1', 5]), 'SKU-1', 2)).toEqual(cart(['SKU-1', 2]));
  });

  it('leaves the other lines exactly as they were', () => {
    expect(set(cart(['A', 1], ['B', 5], ['C', 2]), 'B', 3)).toEqual(
      cart(['A', 1], ['B', 3], ['C', 2]),
    );
  });

  it('removes the line at zero, which is what typing 0 in the box means', () => {
    expect(set(cart(['SKU-1', 5], ['SKU-2', 1]), 'SKU-1', 0)).toEqual(cart(['SKU-2', 1]));
  });

  it('ignores a SKU that is not in the cart', () => {
    // A stale form, not a request to add: the customer is looking at a cart that
    // has moved on, and quietly adding an item would be the wrong repair.
    expect(set(cart(['SKU-1', 1]), 'SKU-9', 3)).toEqual(cart(['SKU-1', 1]));
  });

  it('hands back the very same cart, rather than a copy of it', () => {
    // Identity, not equality. Mutation testing showed the early return could be
    // deleted with every test still passing, because rebuilding the lines
    // produces an equal cart — equal, but rebuilt for nothing.
    const before = cart(['SKU-1', 1]);
    const result = setQuantity(before, 'SKU-9', 3);

    expect(result.ok && result.value).toBe(before);
  });

  it('refuses a quantity past the maximum, and says why', () => {
    expect(setQuantity(cart(['SKU-1', 1]), 'SKU-1', MAX_QUANTITY + 1)).toEqual({
      ok: false,
      error: { tag: 'quantity_out_of_range', quantity: MAX_QUANTITY + 1, max: MAX_QUANTITY },
    });
  });

  it('refuses a fractional quantity', () => {
    expect(setQuantity(cart(['SKU-1', 1]), 'SKU-1', 2.5).ok).toBe(false);
  });

  it('refuses a negative quantity rather than reading it as a removal', () => {
    // Only an explicit zero removes. -1 is a broken caller.
    expect(setQuantity(cart(['SKU-1', 1]), 'SKU-1', -1).ok).toBe(false);
  });

  it('refuses a blank SKU, and says which problem it was', () => {
    expect(setQuantity(cart(['SKU-1', 1]), '  ', 1)).toEqual({
      ok: false,
      error: { tag: 'sku_empty' },
    });
  });
});

describe('removeFromCart', () => {
  it('removes the named line', () => {
    expect(removeFromCart(cart(['A', 1], ['B', 2]), 'A')).toEqual(cart(['B', 2]));
  });

  it('is a no-op for a SKU that is not there', () => {
    expect(removeFromCart(cart(['A', 1]), 'ZZ')).toEqual(cart(['A', 1]));
  });

  it('trims, so a form value with whitespace still matches', () => {
    expect(removeFromCart(cart(['A', 1]), ' A ')).toEqual(EMPTY_CART);
  });
});

describe('keepOnly', () => {
  it('drops lines whose SKU is no longer sellable', () => {
    // A product archived while the cart sat open. The rest of the cart survives.
    expect(keepOnly(cart(['A', 1], ['B', 2]), new Set(['B']))).toEqual(cart(['B', 2]));
  });

  it('keeps everything when everything is still sellable', () => {
    expect(keepOnly(cart(['A', 1]), new Set(['A']))).toEqual(cart(['A', 1]));
  });
});

describe('reading a cart', () => {
  it('counts items rather than lines', () => {
    expect(totalItems(cart(['A', 2], ['B', 3]))).toBe(5);
    expect(totalItems(EMPTY_CART)).toBe(0);
  });

  it('reports the quantity of one SKU, or zero', () => {
    expect(quantityOf(cart(['A', 2]), 'A')).toBe(2);
    expect(quantityOf(cart(['A', 2]), 'B')).toBe(0);
  });

  it('knows when it is empty', () => {
    expect(isEmpty(EMPTY_CART)).toBe(true);
    expect(isEmpty(cart(['A', 1]))).toBe(false);
  });
});

describe('the cookie', () => {
  it('round-trips a cart', () => {
    const original = cart(['SKU-1', 2], ['SKU-2', 1]);
    expect(parseCart(formatCart(original))).toEqual(original);
  });

  it('round-trips a SKU containing the characters a join format would break on', () => {
    // The reason it is JSON rather than `sku:qty,sku:qty`. SKUs come from other
    // people's spreadsheets and contain anything.
    const original = cart(['A,B:C/D', 3]);
    expect(parseCart(formatCart(original))).toEqual(original);
  });

  it('round-trips non-Latin characters', () => {
    const original = cart(['كابل-١', 2]);
    expect(parseCart(formatCart(original))).toEqual(original);
  });

  it('produces a value that needs no further encoding to sit in a cookie', () => {
    expect(formatCart(cart(['A,B:C/D', 3]))).toBe(
      encodeURIComponent(formatCart(cart(['A,B:C/D', 3]))),
    );
  });

  it('round-trips an empty cart', () => {
    expect(parseCart(formatCart(EMPTY_CART))).toEqual(EMPTY_CART);
  });

  describe('parsing something unreadable', () => {
    it.each([
      ['absent', undefined],
      ['empty', ''],
      ['not base64url', 'not base64!!'],
      ['not JSON', 'bm90IGpzb24'],
      ['not an array', btoa('{"a":1}').replaceAll('=', '')],
      // In the alphabet, but not a legal base64 length: atob throws rather than
      // returning garbage, and that has to be caught rather than escape.
      ['a single stray character', 'a'],
    ])('reads %s as an empty cart rather than throwing', (_label, cookie) => {
      // A corrupted cookie is a cart the customer refills, not an error page.
      expect(parseCart(cookie)).toEqual(EMPTY_CART);
    });
  });

  describe('parsing individual lines', () => {
    const encode = (value: unknown) =>
      btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

    it('drops one bad line without losing the others', () => {
      const cookie = encode([
        { s: 'A', q: 2 },
        { s: '', q: 1 },
        { s: 'B', q: 1 },
      ]);
      expect(parseCart(cookie)).toEqual(cart(['A', 2], ['B', 1]));
    });

    it.each([
      ['a missing sku', { q: 1 }],
      ['a non-string sku', { s: 5, q: 1 }],
      ['a blank sku', { s: '   ', q: 1 }],
      ['a missing quantity', { s: 'A' }],
      ['a non-numeric quantity', { s: 'A', q: 'many' }],
      ['a fractional quantity', { s: 'A', q: 1.5 }],
      ['a zero quantity', { s: 'A', q: 0 }],
      ['a negative quantity', { s: 'A', q: -3 }],
      ['a null entry', null],
      ['a string entry', 'nonsense'],
    ])('drops %s', (_label, entry) => {
      expect(parseCart(encode([entry]))).toEqual(EMPTY_CART);
    });

    it('CLAMPS a quantity above the maximum rather than dropping the line', () => {
      // Still a request for that item; keeping it at the cap preserves the
      // intent. Zero or negative is not a request for anything, so it goes.
      expect(parseCart(encode([{ s: 'A', q: 9999 }]))).toEqual(cart(['A', MAX_QUANTITY]));
    });

    it('merges a duplicated SKU rather than keeping it twice', () => {
      expect(
        parseCart(
          encode([
            { s: 'A', q: 2 },
            { s: 'A', q: 3 },
          ]),
        ),
      ).toEqual(cart(['A', 5]));
    });

    it('caps a merged duplicate at the maximum', () => {
      const cookie = encode([
        { s: 'A', q: 90 },
        { s: 'A', q: 90 },
      ]);
      expect(parseCart(cookie)).toEqual(cart(['A', MAX_QUANTITY]));
    });

    it('stops at the line limit rather than accepting a crafted cookie', () => {
      const many = Array.from({ length: MAX_LINES + 20 }, (_, i) => ({ s: `S-${i}`, q: 1 }));
      expect(parseCart(encode(many)).lines).toHaveLength(MAX_LINES);
    });

    it('past the limit, still MERGES a duplicate of a line it already kept', () => {
      /*
       * The cap costs the tail, not the total: a new SKU past thirty is dropped,
       * but a second helping of something already in the cart is not a new line
       * and still counts. Mutation testing found this claim untested — the cap
       * could be made to swallow duplicates too with nothing failing.
       */
      const many = Array.from({ length: MAX_LINES + 5 }, (_, i) => ({ s: `S-${i}`, q: 1 }));
      const withDuplicate = [...many, { s: 'S-0', q: 4 }];

      const parsed = parseCart(encode(withDuplicate));

      expect(parsed.lines).toHaveLength(MAX_LINES);
      expect(parsed.lines.find((line) => line.sku === 'S-0')?.quantity).toBe(5);
    });

    it('trims a SKU on the way in', () => {
      expect(parseCart(encode([{ s: '  A  ', q: 1 }]))).toEqual(cart(['A', 1]));
    });

    it('survives content whose base64 contains + and /, which a cookie cannot', () => {
      /*
       * The whole reason the encoding is base64URL rather than base64: `+` and
       * `/` are not safe in a cookie value, so they are swapped for `-` and `_`
       * and swapped back on the way in.
       *
       * Mutation testing found that swap completely untested — every existing
       * round-trip happened to produce base64 with neither character in it, so
       * either replacement could be deleted and nothing noticed.
       */
      const skus = ['SKU-ÿÿ', 'SKU-þÿþ', 'جهاز'];
      const raw = formatCart({ lines: skus.map((sku) => ({ sku, quantity: 1 })) });

      // The premise: without the swap this value could not be a cookie at all.
      expect(
        btoa(
          String.fromCharCode(
            ...new TextEncoder().encode(JSON.stringify(skus.map((sku) => ({ s: sku, q: 1 })))),
          ),
        ),
      ).toMatch(/[+/]/);

      expect(raw).not.toMatch(/[+/=]/);
      expect(parseCart(raw).lines.map((line) => line.sku)).toEqual(skus);
    });
  });
});
