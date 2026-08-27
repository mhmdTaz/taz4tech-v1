import { LOCALES, type Locale } from '@platform/locale';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Suspense } from 'react';
import { CollectionList } from './collection-list';

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'collections' });

  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: {
      canonical: `/${locale}/collections`,
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [l, `/${l}/collections`])),
        'x-default': '/en/collections',
      },
    },
  };
}

export default async function CollectionsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('collections');

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">{t('title')}</h1>
        <p className="text-base text-muted">{t('subtitle')}</p>
      </header>

      <Suspense fallback={<p className="text-sm text-faint">{t('loading')}</p>}>
        <CollectionList locale={locale as Locale} />
      </Suspense>
    </main>
  );
}
