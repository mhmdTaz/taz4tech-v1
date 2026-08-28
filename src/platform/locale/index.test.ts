import { describe, expect, it } from 'vitest';
import {
  createLocalizedText,
  directionOf,
  englishOnly,
  FALLBACK_LOCALE,
  isLocale,
  isTranslated,
  LOCALES,
  type LocalizedText,
  missingTranslations,
  textFor,
} from './index';

describe('locales', () => {
  it('offers exactly en, ar and fr', () => {
    expect([...LOCALES]).toEqual(['en', 'ar', 'fr']);
  });

  it('falls back to English', () => {
    expect(FALLBACK_LOCALE).toBe('en');
    expect(LOCALES).toContain(FALLBACK_LOCALE);
  });

  it('recognises a supported locale', () => {
    for (const locale of LOCALES) expect(isLocale(locale)).toBe(true);
  });

  it('rejects anything else, including near-misses', () => {
    expect(isLocale('de')).toBe(false);
    expect(isLocale('en-US')).toBe(false);
    expect(isLocale('EN')).toBe(false);
    expect(isLocale('')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(42)).toBe(false);
  });

  it('sets direction from the locale, so ar mirrors everywhere at once', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
    expect(directionOf('fr')).toBe('ltr');
  });
});

describe('textFor', () => {
  const full: LocalizedText = { en: 'Laptop', ar: 'حاسوب محمول', fr: 'Ordinateur portable' };

  it('returns the translation when there is one', () => {
    expect(textFor(full, 'en')).toBe('Laptop');
    expect(textFor(full, 'ar')).toBe('حاسوب محمول');
    expect(textFor(full, 'fr')).toBe('Ordinateur portable');
  });

  it('falls back to English when a locale is untranslated', () => {
    const partial: LocalizedText = { en: 'Laptop', fr: 'Ordinateur portable' };
    expect(textFor(partial, 'ar')).toBe('Laptop');
    expect(textFor(partial, 'fr')).toBe('Ordinateur portable');
  });

  it('falls back when a translation is present but empty', () => {
    // An empty string would otherwise render as a blank heading — worse than
    // showing English, because it looks like the page failed to load.
    const blank = { en: 'Laptop', ar: '' } as LocalizedText;
    expect(textFor(blank, 'ar')).toBe('Laptop');
  });

  it('never returns undefined, whatever is missing', () => {
    const minimal = englishOnly('Laptop');
    for (const locale of LOCALES) {
      expect(typeof textFor(minimal, locale)).toBe('string');
      expect(textFor(minimal, locale).length).toBeGreaterThan(0);
    }
  });
});

describe('isTranslated', () => {
  it('is true only where the locale has its own text', () => {
    const partial: LocalizedText = { en: 'Laptop', ar: 'حاسوب محمول' };
    expect(isTranslated(partial, 'en')).toBe(true);
    expect(isTranslated(partial, 'ar')).toBe(true);
    expect(isTranslated(partial, 'fr')).toBe(false);
  });

  it('treats whitespace as untranslated', () => {
    const blank = { en: 'Laptop', fr: '   ' } as LocalizedText;
    expect(isTranslated(blank, 'fr')).toBe(false);
  });

  it('reports an empty fallback as untranslated', () => {
    expect(isTranslated({ en: '   ' }, 'en')).toBe(false);
  });
});

describe('missingTranslations', () => {
  it('lists the locales still to be filled in', () => {
    expect(missingTranslations(englishOnly('Laptop'))).toEqual(['ar', 'fr']);
    expect(missingTranslations({ en: 'Laptop', ar: 'حاسوب' })).toEqual(['fr']);
    expect(missingTranslations({ en: 'a', ar: 'b', fr: 'c' })).toEqual([]);
  });

  it('counts a blank translation as missing, not as done', () => {
    expect(missingTranslations({ en: 'Laptop', ar: '  ' } as LocalizedText)).toContain('ar');
  });
});

describe('createLocalizedText', () => {
  it('accepts text with only the fallback', () => {
    const result = createLocalizedText({ en: 'Laptop' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ en: 'Laptop' });
  });

  it('trims every locale so padding cannot create a distinct value', () => {
    const result = createLocalizedText({ en: '  Laptop  ', ar: '  حاسوب  ', fr: ' PC ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ en: 'Laptop', ar: 'حاسوب', fr: 'PC' });
  });

  it('rejects a missing or blank fallback', () => {
    for (const en of ['', '   ']) {
      const result = createLocalizedText({ en });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('fallback_empty');
    }
  });

  it('rejects a translation supplied as whitespace', () => {
    // Present-but-blank passes any check that only tests for presence, then
    // renders as an empty heading instead of falling back to English.
    const result = createLocalizedText({ en: 'Laptop', ar: '   ' });
    expect(result).toMatchObject({ ok: false, error: { tag: 'translation_blank', locale: 'ar' } });
  });

  it('reports the French blank too, not only the first locale checked', () => {
    const result = createLocalizedText({ en: 'Laptop', fr: '' });
    expect(result).toMatchObject({ ok: false, error: { tag: 'translation_blank', locale: 'fr' } });
  });

  it('omits absent locales rather than storing undefined', () => {
    const result = createLocalizedText({ en: 'Laptop' });
    if (result.ok) {
      expect(Object.hasOwn(result.value, 'ar')).toBe(false);
      expect(Object.hasOwn(result.value, 'fr')).toBe(false);
    }
  });
});

describe('englishOnly', () => {
  it('builds text with just the fallback', () => {
    expect(englishOnly('Laptop')).toEqual({ en: 'Laptop' });
  });
});
