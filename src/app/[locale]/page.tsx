import { Panel } from '@ui/primitives/panel';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Suspense } from 'react';
import { StoreSummary } from './store-summary';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;

  // Same reason as the layout: supply the locale rather than letting next-intl
  // read it from headers(), so this shell can be prerendered per locale.
  setRequestLocale(locale);

  const t = await getTranslations('home');

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-20">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-accent">{t('eyebrow')}</p>
        <h1 className="text-4xl font-semibold tracking-tight text-ink">{t('title')}</h1>
        <p className="text-base text-muted">{t('tagline')}</p>
      </header>

      {/*
        Everything above is static per locale. Everything that touches the
        database sits behind this boundary, so a slow or unreachable Atlas
        delays one panel instead of blanking the page.
      */}
      <Suspense
        fallback={
          <Panel heading={t('storeHeading')}>
            <p className="text-sm text-faint">{t('loading')}</p>
          </Panel>
        }
      >
        <StoreSummary locale={locale} />
      </Suspense>
    </main>
  );
}
