import { isLocale } from '@platform/locale';
import { PageHeader, Section, WrittenPage } from '@ui/primitives/prose';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};

  const t = await getTranslations({ locale, namespace: 'terms' });
  return { title: t('metaTitle'), alternates: { canonical: `/${locale}/terms` } };
}

export default async function TermsPage({ params }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'terms' });

  const sections = [
    ['whoHeading', 'whoBody'],
    ['pricesHeading', 'pricesBody'],
    ['orderHeading', 'orderBody'],
    ['paymentHeading', 'paymentBody'],
    ['cancelHeading', 'cancelBody'],
    // Before the closing section on purpose: a customer who stops reading after
    // the promises should already have read that the promises are a floor.
    ['rightsHeading', 'rightsBody'],
    ['changesHeading', 'changesBody'],
  ] as const;

  return (
    <WrittenPage>
      <PageHeader title={t('title')} standfirst={t('intro')} />

      {sections.map(([heading, body]) => (
        <Section key={heading} heading={t(heading)}>
          <p>{t(body)}</p>
        </Section>
      ))}
    </WrittenPage>
  );
}
