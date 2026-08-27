import { deliveryFeeFor } from '@modules/store';
import { isLocale } from '@platform/locale';
import { format as formatMoney } from '@platform/money';
import { REGIONS } from '@platform/regions';
import { ButtonLink, PageHeader, Section, Steps, WrittenPage } from '@ui/primitives/prose';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Suspense } from 'react';
import { getContainer } from '@/composition';

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};

  const t = await getTranslations({ locale, namespace: 'delivery' });
  return { title: t('metaTitle'), alternates: { canonical: `/${locale}/delivery` } };
}

export default async function DeliveryPage({ params }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'delivery' });

  return (
    <WrittenPage>
      <PageHeader title={t('title')} standfirst={t('intro')} />

      <Section heading={t('howHeading')}>
        <Steps>
          <li>{t('how1')}</li>
          <li>{t('how2')}</li>
          <li>{t('how3')}</li>
        </Steps>
      </Section>

      <Section heading={t('feesHeading')}>
        <p>{t('feesNote')}</p>

        {/*
          The prices themselves come from the database, so this page cannot drift
          from what checkout charges. Behind a boundary so the words above it
          still prerender: a customer reading how delivery works should not wait
          on a query to see the sentence explaining it.
        */}
        <Suspense fallback={<p className="text-faint">·</p>}>
          <FeeTable locale={locale} />
        </Suspense>
      </Section>

      <Section heading={t('timingHeading')}>
        <p>{t('timingBody')}</p>
      </Section>

      <Section heading={t('checkHeading')}>
        <p>{t('checkBody')}</p>
        <ButtonLink href={`/${locale}/returns`} tone="quiet">
          {t('moreLink')}
        </ButtonLink>
      </Section>
    </WrittenPage>
  );
}

/**
 * What delivery costs, per governorate, read live.
 *
 * A hand-written table here would be a second answer to a question the settings
 * screen already answers — and the one customers read would be the one nobody
 * remembers to update.
 */
const FeeTable = async ({ locale }: { locale: 'en' | 'ar' | 'fr' }) => {
  await connection();

  const t = await getTranslations({ locale, namespace: 'delivery' });
  const tRegion = await getTranslations({ locale, namespace: 'region' });

  const container = await getContainer();
  const settings = await container.store.getStoreSettings();
  if (!settings.ok) return null;

  return (
    <div className="overflow-x-auto rounded-[var(--radius-panel)] border border-hairline">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{t('feesHeading')}</caption>
        <thead>
          <tr className="border-hairline border-b">
            <th scope="col" className="px-4 py-3 text-start font-medium text-faint">
              {t('governorate')}
            </th>
            <th scope="col" className="px-4 py-3 text-end font-medium text-faint">
              {t('cost')}
            </th>
          </tr>
        </thead>
        <tbody>
          {REGIONS.map((region) => {
            const cents = deliveryFeeFor(settings.value, region);

            return (
              <tr key={region} className="border-hairline/60 border-b last:border-b-0">
                <th scope="row" className="px-4 py-3 text-start font-normal text-ink">
                  {tRegion(region)}
                </th>
                <td className="px-4 py-3 text-end tabular-nums text-ink">
                  {cents === 0 ? (
                    <span className="text-positive">{t('free')}</span>
                  ) : (
                    formatMoney({ cents, currency: 'USD' }, locale)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
