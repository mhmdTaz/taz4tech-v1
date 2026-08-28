import { describe, expect, it } from 'vitest';
import { expandSearchTerms, isSearchable, normaliseSearchText, SYNONYM_GROUPS } from './search';

describe('normaliseSearchText', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normaliseSearchText('  Lenovo   IdeaPad  ')).toBe('lenovo ideapad');
  });

  it('folds every alef form to one', () => {
    // آ أ إ ٱ are all alef. Someone typing أحمد must match احمد.
    const forms = ['أحمد', 'إحمد', 'آحمد', 'ٱحمد'];
    const normalised = forms.map(normaliseSearchText);
    expect(new Set(normalised).size).toBe(1);
    expect(normalised[0]).toBe('احمد');
  });

  it('folds ta marbuta to ha, so شاشه matches شاشة', () => {
    // This is not a typo — it is how the word is commonly typed.
    expect(normaliseSearchText('شاشة')).toBe(normaliseSearchText('شاشه'));
  });

  it('folds alef maqsura to ya', () => {
    expect(normaliseSearchText('مصطفى')).toBe(normaliseSearchText('مصطفي'));
  });

  it('strips diacritics, which are usually omitted when typing', () => {
    // "كِتَاب" typed with tashkeel must match "كتاب" typed without.
    expect(normaliseSearchText('كِتَاب')).toBe(normaliseSearchText('كتاب'));
  });

  it('strips the tatweel stretch mark used for justification', () => {
    expect(normaliseSearchText('كتـــاب')).toBe(normaliseSearchText('كتاب'));
  });

  it('strips every mark in the documented range, not just the common ones', () => {
    /*
     * The removable set is built from a range, and a range has two ends. The
     * marks people actually type sit near the bottom of it (fatha, kasra,
     * shadda), so a test using only those leaves the top end unstated: the
     * range could be built one short and every such test would still pass.
     *
     * U+064B..U+065F is tashkeel, U+0670 is the superscript alef, and U+0640 is
     * the tatweel.
     */
    const marks = [
      ...Array.from({ length: 0x065f - 0x064b + 1 }, (_, i) => 0x064b + i),
      0x0670,
      0x0640,
    ];
    for (const code of marks) {
      const mark = String.fromCharCode(code);
      expect(
        normaliseSearchText(`كتاب${mark}`),
        `U+${code.toString(16).toUpperCase().padStart(4, '0')} survived normalisation`,
      ).toBe('كتاب');
    }
  });

  it('leaves latin text otherwise intact', () => {
    expect(normaliseSearchText('IdeaPad 3 15.6"')).toBe('ideapad 3 15.6"');
  });

  it('returns an empty string for whitespace', () => {
    expect(normaliseSearchText('    ')).toBe('');
  });

  it('is idempotent', () => {
    // It runs on both the query and the indexed text, so applying it twice must
    // not drift.
    for (const input of ['أحمد', 'شاشة', 'Lenovo IdeaPad', 'كِتَاب']) {
      const once = normaliseSearchText(input);
      expect(normaliseSearchText(once)).toBe(once);
    }
  });
});

describe('expandSearchTerms', () => {
  it('returns nothing for an empty query', () => {
    for (const input of ['', '   ']) {
      const result = expandSearchTerms(input);
      expect(result.query).toBe('');
      expect(result.terms).toEqual([]);
    }
  });

  it('always includes what the customer actually typed', () => {
    expect(expandSearchTerms('ideapad').terms).toContain('ideapad');
  });

  it('expands English to Arabic', () => {
    // The point of the whole exercise.
    expect(expandSearchTerms('laptop').terms).toContain('لابتوب');
  });

  it('expands Arabic to English, so an Arabic search finds an English catalogue', () => {
    // Without this, "لابتوب" returns nothing from a catalogue full of laptops —
    // not a ranking problem, an empty shop.
    const terms = expandSearchTerms('لابتوب').terms;
    expect(terms).toContain('laptop');
    expect(terms).toContain('notebook');
  });

  it('expands French too', () => {
    expect(expandSearchTerms('ordinateur portable').terms).toContain('laptop');
  });

  it('matches a multi-word synonym as one concept', () => {
    // "hard drive" must expand as storage, not as "hard" plus "drive".
    const terms = expandSearchTerms('hard drive').terms;
    expect(terms).toContain('ssd');
    expect(terms).toContain('تخزين');
  });

  it('expands each word of a multi-word query', () => {
    const terms = expandSearchTerms('laptop charger').terms;
    expect(terms).toContain('لابتوب');
    expect(terms).toContain('شاحن');
  });

  it('normalises before matching a synonym', () => {
    // Typed with a different alef form, it must still find the group.
    expect(expandSearchTerms('Laptop').terms).toContain('لابتوب');
    expect(expandSearchTerms('شاشه').terms).toContain('monitor');
  });

  it('never returns duplicates', () => {
    const terms = expandSearchTerms('laptop notebook laptop').terms;
    expect(new Set(terms).size).toBe(terms.length);
  });

  it('passes an unknown term through unchanged', () => {
    const result = expandSearchTerms('lenovo');
    expect(result.terms).toEqual(['lenovo']);
  });

  it('searches for the whole phrase as well as its words', () => {
    // A single-word query cannot tell these apart: the phrase and the word are
    // the same string. Two unknown words can — dropping either the phrase or
    // the per-word terms leaves a search that still returns something, just not
    // the right thing.
    expect(expandSearchTerms('lenovo ideapad').terms).toEqual([
      'lenovo ideapad',
      'lenovo',
      'ideapad',
    ]);
  });

  it('does not expand a synonym that is merely part of a longer word', () => {
    // "laptops" is not "laptop" here. Stemming is Mongo's job in the $text
    // index; matching on substrings would make "case" expand inside "staircase".
    expect(expandSearchTerms('laptops').terms).toEqual(['laptops']);
  });

  it('truncates an absurdly long query rather than searching for it', () => {
    const result = expandSearchTerms('a'.repeat(500));
    expect(result.query.length).toBeLessThanOrEqual(120);
  });

  it('does not leave a half-cut word boundary behind after truncating', () => {
    // The cut lands exactly on the space at index 119, so the truncated query
    // ends with one. Left there it becomes a trailing empty term in the $text
    // search — a term that matches nothing and reads as a bug in the query log.
    const result = expandSearchTerms(`${'a'.repeat(119)} bbbb`);
    expect(result.query).toBe('a'.repeat(119));
    expect(result.terms).toEqual(['a'.repeat(119)]);
  });
});

describe('the synonym vocabulary', () => {
  it('has no term appearing in two groups with different meanings', () => {
    // A term in two groups gets the union of both, which quietly makes every
    // search for it broader than either group intended. Worth knowing about.
    const seen = new Map<string, number>();
    for (const [index, group] of SYNONYM_GROUPS.entries()) {
      for (const term of group) {
        const normalised = normaliseSearchText(term);
        const first = seen.get(normalised);
        expect(
          first === undefined || first === index,
          `"${term}" appears in groups ${String(first)} and ${index}`,
        ).toBe(true);
        seen.set(normalised, index);
      }
    }
  });

  it('has at least one Arabic term in every group', () => {
    // A group with no Arabic term does nothing for the customers this feature
    // exists to serve.
    const hasArabic = (term: string) =>
      [...term].some((c) => (c.codePointAt(0) ?? 0) >= 0x0600 && (c.codePointAt(0) ?? 0) <= 0x06ff);
    for (const group of SYNONYM_GROUPS) {
      expect(group.some(hasArabic), `no Arabic in: ${group.join(', ')}`).toBe(true);
    }
  });

  it('normalises every term to something non-empty', () => {
    for (const group of SYNONYM_GROUPS) {
      for (const term of group) expect(normaliseSearchText(term).length).toBeGreaterThan(0);
    }
  });
});

describe('isSearchable', () => {
  it('is false for nothing usable', () => {
    expect(isSearchable('')).toBe(false);
    expect(isSearchable('   ')).toBe(false);
  });

  it('is true for real input', () => {
    expect(isSearchable('laptop')).toBe(true);
    expect(isSearchable('لابتوب')).toBe(true);
  });
});
