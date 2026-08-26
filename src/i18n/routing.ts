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
  locales: ['en', 'ar', 'fr'],
  defaultLocale: 'en',
  localePrefix: 'always',
});
