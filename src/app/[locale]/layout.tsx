import { directionOf, isLocale } from '@modules/store';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import '../globals.css';

/**
 * Pre-render one shell per locale. Because localePrefix is 'always', these three
 * are the only valid top-level segments, and anything else is a 404 rather than
 * a soft redirect that would leak crawl budget onto nonexistent URLs.
 */
export const generateStaticParams = () => routing.locales.map((locale) => ({ locale }));

export const metadata: Metadata = {
  title: 'Taz4Tech',
  description: 'Electronics, delivered across Lebanon. Cash on delivery.',
};

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
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
