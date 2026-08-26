import { FALLBACK_LOCALE, LOCALES } from '@platform/locale';
import { defineRouting } from 'next-intl/routing';

/**
 * Locales as subdirectories: /en, /ar, /fr — never a bare path.
 *
 * 'always' rather than 'as-needed' so every page has exactly one canonical URL
 * per locale. With 'as-needed' the default locale is reachable at both / and /en,
 * which splits ranking signals between two URLs and makes hreflang self-reference
 * ambiguous — a real cost given how hard the electronics vertical already is.
 */
export const routing = defineRouting({
  // Derived, not repeated. A hardcoded list here would let the router offer a
  // locale the rest of the system cannot render, or vice versa.
  locales: LOCALES,
  defaultLocale: FALLBACK_LOCALE,
  localePrefix: 'always',
});
