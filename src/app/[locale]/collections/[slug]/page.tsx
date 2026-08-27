import type { Collection } from '@modules/catalog';
import { isLocale, LOCALES, type Locale, textFor } from '@platform/locale';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { cache } from 'react';
import { getContainer } from '@/composition';
import { ProductGrid } from '../../products/product-grid';

type PageProps = {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Loaded once per request; generateMetadata and the page body share it. */
const loadCollection = cache(async (slug: string): Promise<Collection | null> => {
  const container = await getContainer();
  const result = await container.catalog.getCollection(slug);
  return result.ok ? result.value : null;
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};

  const collection = await loadCollection(slug);
  if (collection === null) {
    const t = await getTranslations({ locale, namespace: 'collections' });
    return { title: t('notFoundTitle') };
  }

  const path = (l: Locale) => `/${l}/collections/${collection.slug}`;

  return {
    title: textFor(collection.title, locale),
    description: textFor(collection.description, locale),
    alternates: {
      // Canonical is the bare collection URL, never a filtered one: every facet
      // combination renders substantially the same page.
      canonical: path(locale),
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [l, path(l)])),
        'x-default': path('en'),
      },
    },
  };
}

export default async function CollectionPage({ params, searchParams }: PageProps) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  // Reads a database, so it must not be prerendered at build time.
  await connection();

  const collection = await loadCollection(slug);
  // Draft, archived and non-existent all render the same 404 on the storefront.
  if (collection === null) notFound();

  const t = await getTranslations('collections');

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16">
      <nav aria-label={t('breadcrumb')} className="text-sm">
        <a
          href={`/${locale}/collections`}
          className="text-muted underline-offset-4 hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t('title')}
        </a>
      </nav>

      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">
          {textFor(collection.title, locale)}
        </h1>
        <p className="text-base text-muted">{textFor(collection.description, locale)}</p>
      </header>

      {/*
        The same grid as the main listing, given a collection. Search, facets,
        pagination and every empty state come along unchanged — which is the
        payoff for modelling a collection as a saved query rather than as its
        own listing path.
      */}
      <ProductGrid
        locale={locale as Locale}
        searchParams={searchParams}
        collection={collection}
        basePath={`/${locale}/collections/${collection.slug}`}
      />
    </main>
  );
}
