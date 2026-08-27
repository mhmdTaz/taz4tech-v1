import { isLocale } from '@platform/locale';
import { formatForDisplay, toWhatsAppNumber } from '@platform/phone';
import { ButtonLink, PageHeader, Section, WrittenPage } from '@ui/primitives/prose';
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

  const t = await getTranslations({ locale, namespace: 'contact' });
  return { title: t('metaTitle'), alternates: { canonical: `/${locale}/contact` } };
}

export default async function ContactPage({ params }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'contact' });

  return (
    <WrittenPage>
      <PageHeader title={t('title')} standfirst={t('intro')} />

      {/*
        The number is the only thing on this page that comes from the database,
        and it is the whole point of the page — so the sections around it render
        immediately and it arrives on its own.
      */}
      <Suspense fallback={<p className="text-faint">·</p>}>
        <Reach locale={locale} />
      </Suspense>

      <Section heading={t('orderHeading')}>
        <p>{t('orderBody')}</p>
      </Section>
    </WrittenPage>
  );
}

const Reach = async ({ locale }: { locale: 'en' | 'ar' | 'fr' }) => {
  await connection();

  const t = await getTranslations({ locale, namespace: 'contact' });

  const container = await getContainer();
  const settings = await container.store.getStoreSettings();

  if (!settings.ok) {
    return (
      <Section heading={t('phoneHeading')}>
        <p className="text-caution">{t('notConfigured')}</p>
      </Section>
    );
  }

  const phone = settings.value.contactPhone;

  return (
    <>
      <Section heading={t('phoneHeading')}>
        <p>{t('phoneBody')}</p>
        {/*
          dir="ltr" on the number itself. A phone number is left-to-right in
          every language, and an Arabic page that mirrors it puts the country
          code at the wrong end of something people read digit by digit.
        */}
        <a
          href={`tel:${phone}`}
          className="self-start rounded-lg border border-hairline px-4 py-2.5 font-mono text-base text-ink transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          dir="ltr"
        >
          {formatForDisplay(phone)}
        </a>
      </Section>

      <Section heading={t('whatsappHeading')}>
        <p>{t('whatsappBody')}</p>
        <ButtonLink href={`https://wa.me/${toWhatsAppNumber(phone)}`}>
          {t('whatsappCta')}
        </ButtonLink>
      </Section>
    </>
  );
};
