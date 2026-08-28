import { isLocale } from '@platform/locale';
import { ButtonLink, PageHeader, Section, WrittenPage } from '@ui/primitives/prose';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};

  const t = await getTranslations({ locale, namespace: 'returns' });
  return { title: t('metaTitle'), alternates: { canonical: `/${locale}/returns` } };
}

export default async function ReturnsPage({ params }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'returns' });

  return (
    <WrittenPage>
      <PageHeader title={t('title')} standfirst={t('intro')} />

      <Section heading={t('doorHeading')}>
        <p>{t('doorBody')}</p>
      </Section>

      <Section heading={t('afterHeading')}>
        <p>{t('afterBody')}</p>
      </Section>

      <Section heading={t('notHeading')}>
        <p>{t('notBody')}</p>
        {/*
          Here rather than at the foot of the page: this is the section a
          customer reads as taking something away, so it is where the sentence
          saying it does not belongs.
        */}
        <p>{t('rightsNote')}</p>
      </Section>

      <Section heading={t('howHeading')}>
        <p>{t('howBody')}</p>
        <ButtonLink href={`/${locale}/contact`}>{t('contactLink')}</ButtonLink>
      </Section>
    </WrittenPage>
  );
}
