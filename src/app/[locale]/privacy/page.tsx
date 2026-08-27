import { isLocale } from '@platform/locale';
import { PageHeader, Section, WrittenPage } from '@ui/primitives/prose';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};

  const t = await getTranslations({ locale, namespace: 'privacy' });
  return { title: t('metaTitle'), alternates: { canonical: `/${locale}/privacy` } };
}

export default async function PrivacyPage({ params }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'privacy' });

  const sections = [
    ['whatHeading', 'whatBody'],
    ['whyHeading', 'whyBody'],
    ['shareHeading', 'shareBody'],
    ['cookiesHeading', 'cookiesBody'],
    ['askHeading', 'askBody'],
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
