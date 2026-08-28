import { LOCALES, type Locale } from '@platform/locale';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
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
        NOT behind a Suspense boundary, and that is the whole decision.

        It used to be. The heading is static per locale and only the grid
        touches the database, so streaming the tiles in afterwards let the shell
        render immediately — and React swaps streamed content into place with an
        inline script. With JavaScript disabled, or still downloading over a
        Lebanese mobile connection, that swap never happens and the page sits on
        a skeleton forever. Every tile was in the HTML; none of it was on screen.

        This is the same wall the footer hit, decided the same way: a legal
        disclosure that needs JavaScript is not a disclosure, and a product
        listing that needs JavaScript is not a listing. The collection page has
        always rendered this exact grid without a boundary, so the listing was
        the odd one out rather than the pattern.

        The cost is narrower than it looks. Every storefront route was already
        dynamic — the footer's `connection()` sees to that — so nothing stopped
        being prerendered. What changes is that the response now waits on one
        indexed query before it starts, instead of sending a heading and
        following it with the tiles. Lighthouse is the gate for that, and it
        runs on every PR.
      */}
      <ProductGrid locale={locale as Locale} searchParams={searchParams} />
    </main>
  );
}
