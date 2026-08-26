import type { GetStoreSettingsError, StoreSettings } from '@modules/store';
import { showsRegistryNumber } from '@modules/store';
import type { Result } from '@platform/result';
import { Field, Panel } from '@ui/primitives/panel';
import { connection } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getContainer } from '@/composition';

/**
 * The delivery layer at its thinnest: await one use case, render the Result.
 *
 * There is no business logic here on purpose. Async Server Components cannot be
 * unit tested, so anything that could be wrong lives in the use case next door,
 * which is tested at 100%.
 */
export const StoreSummary = async ({ locale }: { locale: string }) => {
  // Opt out of prerendering: this reads a database, and a build machine has no
  // business connecting to production Atlas to generate a page. The Suspense
  // boundary in page.tsx is what lets the rest of the page prerender anyway.
  await connection();

  // The locale is passed in rather than read from the request, so this component
  // does not reintroduce the dynamic locale lookup the shell just avoided.
  const t = await getTranslations({ locale, namespace: 'home' });

  let result: Result<StoreSettings, GetStoreSettingsError>;
  try {
    const container = await getContainer();
    result = await container.store.getStoreSettings();
  } catch {
    // Unexpected failure — bad config, Atlas unreachable. The customer gets a
    // sentence, not a stack trace; the detail is already in the structured log.
    return (
      <Panel heading={t('storeHeading')}>
        <p className="text-sm text-negative">{t('lookupFailed')}</p>
      </Panel>
    );
  }

  if (!result.ok) {
    return (
      <Panel heading={t('storeHeading')}>
        <p className="text-sm text-caution">{t('notConfigured')}</p>
      </Panel>
    );
  }

  const settings = result.value;
  return (
    <Panel heading={t('storeHeading')}>
      <dl>
        <Field label={t('labels.name')}>{settings.name}</Field>
        <Field label={t('labels.locales')}>{settings.locales.join(' · ')}</Field>
        <Field label={t('labels.vat')}>{(settings.vatBasisPoints / 100).toFixed(2)}%</Field>
        <Field label={t('labels.contact')}>{settings.contactPhone}</Field>
        {showsRegistryNumber(settings) && (
          <Field label={t('labels.registry')}>{settings.commercialRegistryNumber}</Field>
        )}
      </dl>
    </Panel>
  );
};
