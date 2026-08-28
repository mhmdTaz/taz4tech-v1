import { isLocale } from '@platform/locale';
import { ButtonLink } from '@ui/primitives/prose';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Suspense } from 'react';
import { CollectionStrip, NewArrivals, StripSkeleton } from './home-sections';

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};

  const t = await getTranslations({ locale, namespace: 'home' });
  return { title: t('metaTitle'), description: t('metaDescription') };
}

/**
 * The front door.
 *
 * It used to be the Phase 0 skeleton: an eyebrow reading "Phase 0 · skeleton",
 * and a panel showing customers the shop's VAT rate, its locales and its own
 * phone number — a configuration dump on the page that decides whether somebody
 * trusts this shop with their address. That panel is gone; the seller identity
 * it was accidentally carrying now lives in the footer, where the law expects it.
 *
 * WHAT A COLD VISITOR NEEDS, IN ORDER
 * -----------------------------------
 * This shop has no reviews, no brand recognition and no card payments, and it
 * asks a stranger to let a driver come to their house. So the page leads with
 * what it sells, then answers the three questions that decide whether the rest
 * of the site is worth reading — is anything charged now, do you come to me, and
 * will somebody call — before it shows a single product.
 *
 * The hero and those answers are static per locale and in the first response.
 * Only the two rows that read the catalogue are behind boundaries.
 */
export default async function HomePage({ params }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'home' });

  const assurances = [
    { key: 'cash', body: 'cashBody' },
    { key: 'reach', body: 'reachBody' },
    { key: 'call', body: 'callBody' },
  ] as const;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-16 px-6 py-12 sm:py-16">
      <section className="flex flex-col gap-6">
        <h1 className="max-w-[18ch] text-balance text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          {t('heroTitle')}
        </h1>
        <p className="max-w-[58ch] text-lg text-muted">{t('heroBody')}</p>

        <div className="flex flex-wrap gap-3">
          <ButtonLink href={`/${locale}/products`}>{t('browse')}</ButtonLink>
          <ButtonLink href={`/${locale}/delivery`} tone="quiet">
            {t('howDelivery')}
          </ButtonLink>
        </div>
      </section>

      {/*
        A list, not three floating cards. Three related claims about how this
        shop works are a list, and saying so is what lets a screen-reader user
        hear "3 items" instead of discovering them one at a time.
      */}
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {assurances.map((each) => (
          <li
            key={each.key}
            className="flex flex-col gap-1.5 rounded-[var(--radius-panel)] border border-hairline bg-surface p-5"
          >
            <h2 className="text-sm font-medium text-ink">{t(`assurances.${each.key}`)}</h2>
            <p className="text-sm text-muted">{t(`assurances.${each.body}`)}</p>
          </li>
        ))}
      </ul>

      <Suspense fallback={<StripSkeleton />}>
        <CollectionStrip locale={locale} />
      </Suspense>

      <Suspense fallback={<StripSkeleton rows={2} />}>
        <NewArrivals locale={locale} />
      </Suspense>

      <section aria-labelledby="steps-heading" className="flex flex-col gap-5">
        <h2 id="steps-heading" className="text-2xl font-semibold tracking-tight text-ink">
          {t('stepsHeading')}
        </h2>

        {/*
          Numbered, because the order is the information: nothing is charged
          until the third step, and that is the whole reassurance.
        */}
        <ol className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {(['step1', 'step2', 'step3'] as const).map((step, index) => (
            <li
              key={step}
              className="flex flex-col gap-2 rounded-[var(--radius-panel)] border border-hairline bg-surface p-5"
            >
              <span
                aria-hidden="true"
                className="font-mono text-sm font-medium tabular-nums text-accent"
              >
                {index + 1}
              </span>
              <p className="text-sm text-muted">{t(step)}</p>
            </li>
          ))}
        </ol>

        <a
          href={`/${locale}/delivery`}
          className="self-start text-sm text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t('stepsLink')}
        </a>
      </section>
    </main>
  );
}
