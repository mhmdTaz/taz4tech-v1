import { LOCALES, type Locale } from '@platform/locale';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Suspense } from 'react';
import { ProductGrid } from './product-grid';

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'products' });

  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: {
      canonical: `/${locale}/products`,
      // hreflang for all three locales plus x-default, so a search engine knows
      // these are translations of one page rather than three competing ones.
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [l, `/${l}/products`])),
        'x-default': '/en/products',
      },
    },
  };
}

export default async function ProductsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('products');

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">{t('title')}</h1>
        <p className="text-base text-muted">{t('subtitle')}</p>
      </header>

      {/*
        The heading is static per locale; only the grid touches the database, so
        a slow query delays the tiles rather than blanking the page.
      */}
      <Suspense fallback={<GridSkeleton label={t('loading')} />}>
        {/*
          The searchParams PROMISE is passed down rather than awaited here.
          Awaiting it in the page body makes the whole route dynamic, shell and
          all; awaited inside the boundary, only the grid is.
        */}
        <ProductGrid locale={locale as Locale} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

const GridSkeleton = ({ label }: { label: string }) => (
  <div>
    <p className="sr-only" role="status">
      {label}
    </p>
    <ul
      aria-hidden="true"
      className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
    >
      {[0, 1, 2, 3, 4, 5, 6, 7].map((slot) => (
        <li
          key={slot}
          className="h-72 animate-pulse rounded-[var(--radius-panel)] border border-hairline bg-surface"
        />
      ))}
    </ul>
  </div>
);
