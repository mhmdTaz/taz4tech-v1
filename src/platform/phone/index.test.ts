import { describe, expect, it } from 'vitest';
import { formatForDisplay, isE164, parseLebanesePhone, toWhatsAppNumber } from './index';

const parsed = (input: string): string => {
  const result = parseLebanesePhone(input);
  if (!result.ok) throw new Error(`expected a number, got ${result.error.tag}`);
  return result.value;
};

describe('parseLebanesePhone', () => {
  describe('the shapes a customer actually types', () => {
    it.each([
      ['already E.164', '+9613123456'],
      ['E.164 with spaces', '+961 3 123 456'],
      ['E.164 with dashes', '+961-3-123-456'],
      ['national with a leading zero', '03123456'],
      ['national spaced', '03 123 456'],
      ['national with no zero', '3123456'],
      ['00 instead of a plus', '009613123456'],
      ['brackets and dots', '(+961) 3.123.456'],
      ['padded with spaces', '  03 123 456  '],
    ])('reads %s as one number', (_label, input) => {
      // All of these are the same number. Two records for one customer because
      // one was typed differently is the failure this prevents.
      expect(parsed(input)).toBe('+9613123456');
    });

    it('handles the eight-digit mobile ranges', () => {
      expect(parsed('70123456')).toBe('+96170123456');
      expect(parsed('071123456')).toBe('+96171123456');
      expect(parsed('+961 81 123 456')).toBe('+96181123456');
    });
  });

  describe('refusing rather than guessing', () => {
    it('refuses an empty value', () => {
      expect(parseLebanesePhone('   ')).toEqual({ ok: false, error: { tag: 'empty' } });
    });

    it.each([
      ['letters', '03 ABC 456'],
      ['a bare plus', '+'],
      ['punctuation only', '--()'],
    ])('refuses %s', (_label, input) => {
      expect(parseLebanesePhone(input).ok).toBe(false);
    });

    it('refuses a number that is too short to be one', () => {
      expect(parseLebanesePhone('12345')).toEqual({
        ok: false,
        error: { tag: 'wrong_length', input: '12345' },
      });
    });

    it('refuses a number that is too long', () => {
      expect(parseLebanesePhone('031234567890').ok).toBe(false);
    });

    it('refuses a non-Lebanese international number', () => {
      /*
       * This shop delivers to Lebanon. A number it cannot call is worse than an
       * empty field, which at least reads as missing rather than as contactable.
       */
      expect(parseLebanesePhone('+442071234567')).toEqual({
        ok: false,
        error: { tag: 'not_lebanese', input: '+442071234567' },
      });
    });

    it('does not read a stray leading zero as a country code', () => {
      // 0 is the national trunk prefix, dropped in E.164 — not part of the
      // number, and not something to keep "just in case".
      expect(parsed('03123456')).not.toContain('9610');
    });
  });

  it('is idempotent: parsing its own output changes nothing', () => {
    // Every place a human types a number goes through this, including an edit of
    // one already stored.
    const once = parsed('03 123 456');
    expect(parsed(once)).toBe(once);
  });
});

describe('isE164', () => {
  it.each([
    ['+9613123456', true],
    ['+96170123456', true],
    ['9613123456', false],
    ['+0613123456', false],
    ['+961', false],
    ['', false],
  ])('%s -> %s', (value, expected) => {
    expect(isE164(value)).toBe(expected);
  });
});

describe('formatForDisplay', () => {
  it('groups a seven-digit number for reading aloud', () => {
    expect(formatForDisplay('+9613123456')).toBe('+961 3 123 456');
  });

  it('groups an eight-digit number', () => {
    expect(formatForDisplay('+96170123456')).toBe('+961 70 123 456');
  });

  it('leaves a number it does not recognise exactly as it is', () => {
    // Better an unformatted number than a regrouped one that reads as a
    // different number.
    expect(formatForDisplay('+442071234567')).toBe('+442071234567');
  });

  it('never changes what is stored', () => {
    // Display only. Everything that matches or looks up a customer matches on
    // the stored value, so grouping must not leak back into it.
    const stored = '+9613123456';
    formatForDisplay(stored);
    expect(stored).toBe('+9613123456');
  });
});

describe('toWhatsAppNumber', () => {
  it('drops the plus, which is what a wa.me link wants', () => {
    expect(toWhatsAppNumber('+9613123456')).toBe('9613123456');
  });

  it('leaves a number with no plus alone', () => {
    expect(toWhatsAppNumber('9613123456')).toBe('9613123456');
  });
});
