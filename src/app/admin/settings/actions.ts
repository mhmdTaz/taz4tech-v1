'use server';

import { type ByRegion, REGIONS, type Region } from '@platform/regions';
import { redirect } from 'next/navigation';
import { getContainer } from '@/composition';
import { requireAdmin } from '../session';

/**
 * Saving the store's settings.
 *
 * Post/redirect/get, like every other form in this app: a refresh after a save
 * must not re-post it. The outcome comes back as a query parameter and the page
 * re-reads the settings, so what the operator sees afterwards is what is stored
 * rather than what they typed.
 *
 * On a refusal, what they typed comes BACK — a settings form that empties itself
 * because one field was wrong is a form nobody fills in twice. That is why the
 * values ride along in the query string; they are the shop's own details, not a
 * customer's, and this URL never leaves the admin.
 */

const SETTINGS_PATH = '/admin/settings';

const field = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
};

export const saveSettings = async (formData: FormData): Promise<void> => {
  await requireAdmin();

  const form = {
    name: field(formData, 'name'),
    contactPhone: field(formData, 'contactPhone'),
    commercialRegistryNumber: field(formData, 'commercialRegistryNumber'),
    vatPercent: field(formData, 'vatPercent'),
    // One box per governorate, named deliveryFee.<region>.
    deliveryFees: Object.fromEntries(
      REGIONS.map((region) => [region, field(formData, `deliveryFee.${region}`)]),
    ) as ByRegion<string>,
  };

  const container = await getContainer();
  const result = await container.store.updateStoreSettings(form);

  if (result.ok) {
    container.logger.info('store settings changed', { storeId: result.value.storeId });
    redirect(`${SETTINGS_PATH}?saved=1`);
  }

  // Echoed back so nothing has to be retyped.
  const params = new URLSearchParams({
    name: form.name,
    contactPhone: form.contactPhone,
    commercialRegistryNumber: form.commercialRegistryNumber,
    vatPercent: form.vatPercent,
  });
  for (const region of REGIONS) params.set(`deliveryFee.${region}`, form.deliveryFees[region]);

  /*
   * `error` names the FIELD to point at, not the failure.
   *
   * The page turns it into a sentence and an aria-invalid, and the operator gets
   * an outline round the box that is wrong rather than a paragraph telling them
   * to go and find it.
   */
  params.set(
    'error',
    result.error.tag === 'phone_invalid'
      ? 'phone'
      : result.error.tag === 'vat_unparsable'
        ? 'vat'
        : result.error.tag === 'delivery_fee_unparsable'
          ? `fee.${result.error.region}`
          : result.error.tag === 'not_configured'
            ? 'not_configured'
            : domainField(result.error.reason),
  );

  redirect(`${SETTINGS_PATH}?${params.toString()}`);
};

/** Which box the domain was complaining about. */
const domainField = (error: { readonly tag: string; readonly region?: Region }): string => {
  if (error.tag === 'name_empty') return 'name';
  if (error.tag === 'vat_out_of_range') return 'vat';
  if (error.tag === 'delivery_fee_invalid') return `fee.${error.region}`;
  if (error.tag === 'phone_not_e164') return 'phone';
  // no_locales and default_locale_not_offered cannot come from this form, which
  // never touches those fields. Reaching here means the stored settings are
  // already broken, and saying so beats blaming a box the operator just typed in.
  return 'stored';
};
