/**
 * Locales and translatable text.
 *
 * This lives in platform rather than in a module because every module needs it:
 * the catalogue translates product titles, collections translate names, pages
 * and the blog translate bodies. A module reaching into another module for a
 * string union would be coupling for no reason.
 *
 * The store module still decides which locales a given tenant *offers*. This
 * file only defines which locales the system can express at all.
 */

export const LOCALES = ['en', 'ar', 'fr'] as const;

export type Locale = (typeof LOCALES)[number];

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value);

/** ar is written right-to-left; en and fr are not. Drives dir= on <html>. */
export const directionOf = (locale: Locale): 'ltr' | 'rtl' => (locale === 'ar' ? 'rtl' : 'ltr');

/**
 * The locale every other one falls back to.
 *
 * Not a preference — an invariant. LocalizedText requires `en`, so a fallback
 * always exists and no screen can ever render an empty string because a
 * translation was missing.
 */
export const FALLBACK_LOCALE: Locale = 'en';

/**
 * Text in one or more locales.
 *
 * `en` is required and the others are optional, which matches how the catalogue
 * is actually loaded: an Excel import of manufacturer spec sheets arrives in
 * English, and Arabic and French are filled in over time. Requiring all three
 * up front would mean either blocking the import or writing placeholder text
 * that is indistinguishable from a real translation.
 */
export type LocalizedText = {
  readonly en: string;
  readonly ar?: string;
  readonly fr?: string;
};

/** Resolve text for a locale, falling back to English when untranslated. */
export const textFor = (text: LocalizedText, locale: Locale): string => {
  const translated = locale === 'en' ? text.en : text[locale];
  return translated === undefined || translated.length === 0 ? text.en : translated;
};

/** True when this locale has its own text rather than borrowing the fallback. */
export const isTranslated = (text: LocalizedText, locale: Locale): boolean => {
  if (locale === FALLBACK_LOCALE) return text.en.trim().length > 0;
  const translated = text[locale];
  return translated !== undefined && translated.trim().length > 0;
};

/**
 * Which locales are still untranslated.
 *
 * Drives the "needs translation" filter in the admin and the summary the Excel
 * importer prints after a run — a store that silently serves English to Arabic
 * customers looks finished when it is not.
 */
export const missingTranslations = (text: LocalizedText): Locale[] =>
  LOCALES.filter((locale) => !isTranslated(text, locale));

export type LocalizedTextError =
  | { readonly tag: 'fallback_empty' }
  | { readonly tag: 'translation_blank'; readonly locale: Locale };

/**
 * Build LocalizedText, rejecting the two ways it goes wrong: no fallback at all,
 * or a translation present as whitespace. The second matters more than it looks
 * — a blank string is "translated" to every check that only tests for presence,
 * so it renders as an empty heading rather than falling back to English.
 */
export const createLocalizedText = (
  input: LocalizedText,
): { ok: true; value: LocalizedText } | { ok: false; error: LocalizedTextError } => {
  if (input.en.trim().length === 0) return { ok: false, error: { tag: 'fallback_empty' } };

  for (const locale of LOCALES) {
    if (locale === FALLBACK_LOCALE) continue;
    const translated = input[locale];
    if (translated !== undefined && translated.trim().length === 0) {
      return { ok: false, error: { tag: 'translation_blank', locale } };
    }
  }

  // Trim on the way in so that " Laptop " and "Laptop" cannot both exist as
  // distinct titles, and so slug generation is fed a predictable string.
  const trimmed: { en: string; ar?: string; fr?: string } = { en: input.en.trim() };
  if (input.ar !== undefined) trimmed.ar = input.ar.trim();
  if (input.fr !== undefined) trimmed.fr = input.fr.trim();
  return { ok: true, value: trimmed };
};

/** Shorthand for text that exists only in the fallback locale. */
export const englishOnly = (text: string): LocalizedText => ({ en: text });
