'use client';

import { LOCALES, type Locale } from '@platform/locale';
import { usePathname } from 'next/navigation';

/**
 * Three links, one per language, all pointing at the page you are already on.
 *
 * WHY THIS ONE COMPONENT IS A CLIENT COMPONENT
 * --------------------------------------------
 * Staying on the same page across a language change needs the current path, and
 * a Server Component in a layout has no way to read it. The alternative — three
 * links to the locale home pages — would throw a reader back to the front of the
 * shop for the crime of wanting to read in Arabic.
 *
 * It costs nothing at runtime. `usePathname` resolves during the server render,
 * so the real hrefs are in the HTML: this works with JavaScript disabled and
 * before hydration, exactly like every other link on the storefront.
 *
 * `next/navigation` rather than next-intl's wrapper around it. The wrapper
 * returns a conveniently locale-stripped path, and pulls its client navigation
 * bundle along for the ride — around 6 KB, on every route, for one component
 * that needs one string. Stripping the prefix here is two lines, and the routing
 * config guarantees it is there: `localePrefix: 'always'` means every storefront
 * URL starts with the locale.
 */

const NAMES: Record<Locale, string> = {
  // Each in its own language, never translated. A reader looking for Arabic is
  // looking for "العربية"; "Arabic" written in French helps nobody.
  en: 'English',
  ar: 'العربية',
  fr: 'Français',
};

export const LanguageSwitcher = ({
  current,
  label,
}: {
  readonly current: Locale;
  readonly label: string;
}) => {
  const pathname = usePathname();

  // `/en/products/anker` becomes `/products/anker`, so prefixing another locale
  // gives `/ar/products/anker` rather than `/ar/en/products/anker`.
  const prefix = `/${current}`;
  const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;

  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-2">
      {LOCALES.map((locale) => {
        const active = locale === current;

        return active ? (
          <span
            key={locale}
            aria-current="true"
            className="rounded-lg border border-accent/50 px-2.5 py-1 text-xs text-ink"
          >
            {NAMES[locale]}
          </span>
        ) : (
          <a
            key={locale}
            href={`/${locale}${rest}`}
            // The language of the destination, not of this page. Without it a
            // screen reader announces "Français" in an English voice.
            lang={locale}
            hrefLang={locale}
            className="rounded-lg border border-hairline px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {NAMES[locale]}
          </a>
        );
      })}
    </nav>
  );
};
