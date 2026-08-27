import { getConfig } from '@platform/config';
import { directionOf, isLocale, LOCALES } from '@platform/locale';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import '../globals.css';
import { Suspense } from 'react';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

/**
 * Pre-render one shell per locale. Because localePrefix is 'always', these three
 * are the only valid top-level segments, and anything else is a 404 rather than
 * a soft redirect that would leak crawl budget onto nonexistent URLs.
 */
export const generateStaticParams = () => routing.locales.map((locale) => ({ locale }));

/**
 * metadataBase is what turns every relative `alternates` entry into an absolute
 * URL. Without it Next emits `<link rel="canonical" href="/en/products">`, and
 * Google treats a relative canonical or hreflang as INVALID — it silently
 * ignores both. Lighthouse scored SEO 0.83 on exactly that before this was set,
 * while the pages themselves looked perfectly correct.
 *
 * Read from config rather than the store settings document so that rendering
 * metadata never costs a database round trip.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const { siteUrl } = getConfig();

  return {
    metadataBase: new URL(siteUrl),
    title: 'Taz4Tech',
    description: 'Electronics, delivered across Lebanon. Cash on delivery.',
    alternates: {
      canonical: `/${locale}`,
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [l, `/${l}`])),
        'x-default': '/en',
      },
    },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale) || !isLocale(locale)) notFound();

  // Hands the locale to next-intl directly. Without this it resolves the locale
  // from `headers()`, which Cache Components treats as a dynamic data source and
  // refuses to prerender — the shell would be server-rendered on every request
  // even though it is identical for every visitor in a given locale.
  setRequestLocale(locale);

  // dir is decided by the domain, not by the template — the same function drives
  // the admin, emails and PDFs, so ar can never be RTL in one place and LTR in another.
  return (
    <html lang={locale} dir={directionOf(locale)}>
      <body className="min-h-dvh antialiased">
        <NextIntlClientProvider>
          {/*
            The header reads the cart cookie, which makes it dynamic. Behind its
            own boundary so it cannot stop a page shell from being prerendered
            per locale — the whole reason setRequestLocale is called above.
          */}
          <Suspense fallback={<div className="h-[57px] border-hairline border-b bg-surface/60" />}>
            <SiteHeader locale={locale} />
          </Suspense>
          <div id="content">{children}</div>

          {/*
            NOT behind a boundary, unlike the header above it.

            The header's Suspense resolves before the response flushes, because
            reading a cookie is instant. The footer waits on a database round
            trip, so React flushes the fallback and streams the real content in
            afterwards using an inline script — which means a browser with
            JavaScript disabled never sees it at all. That is merely annoying for
            a product grid. For the one place the shop states who it is, under
            Law 81/2018 Art. 31, a disclosure that needs JavaScript is not a
            disclosure. Found by the e2e spec, which loads a page with JavaScript
            off and reads the footer out of the HTML.

            The cost is one indexed lookup by storeId before the response
            flushes. Every route under this layout is already server-rendered on
            demand, so there is no prerendered shell being given up for it.
          */}
          <SiteFooter locale={locale} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
