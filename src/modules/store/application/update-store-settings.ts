/**
 * Use case: edit the store's settings from a form.
 *
 * Separate from `saveStoreSettings`, which takes an already-shaped
 * `StoreSettings` and is what the seeder calls. This one takes what a browser
 * actually posts — strings, all of them, including "11.5" and "$3.00" — and is
 * where every one of those is turned into the integer the domain demands.
 *
 * It lives here rather than in the Server Action because an action cannot be
 * unit tested. Parsing a percentage is exactly the kind of code that is wrong in
 * a way nobody notices until a number is off by a factor of ten, so it belongs
 * in the layer the coverage gate holds at 100%.
 *
 * ONLY WHAT THE OPERATOR CAN CHANGE
 * ---------------------------------
 * The form covers the fields that visibly change something: the shop's name,
 * phone and registry number on the storefront, the VAT rate it quotes, and the
 * delivery fee every order is charged. Everything else on `StoreSettings` is
 * carried through untouched — the locales and the site URL are decided at build
 * and deploy time, and a field that pretends otherwise is a lie told to whoever
 * edits it.
 */

import { parse as parseAmount } from '@platform/money';
import { type PhoneError, parseLebanesePhone } from '@platform/phone';
import { type ByRegion, REGIONS, type Region } from '@platform/regions';
import { err, ok, type Result } from '@platform/result';
import type { StoreSettingsRepository } from '../contracts';
import {
  createStoreSettings,
  type StoreSettings,
  type StoreSettingsError,
} from '../domain/store-settings';

/** Exactly what the form posts: every value a string, because that is what a form is. */
export type StoreSettingsForm = {
  readonly name: string;
  readonly contactPhone: string;
  /** Blank means the business is not registered yet, which is a real state. */
  readonly commercialRegistryNumber: string;
  /** A percentage as a human writes it: "11", "11.5". */
  readonly vatPercent: string;
  /**
   * What delivery costs, per governorate, as a human writes it: "3", "3.50",
   * "$3.50". All eight, because the stored table has no gaps and no fallback.
   */
  readonly deliveryFees: ByRegion<string>;
};

export type UpdateStoreSettingsError =
  /** Nothing to edit: the store has never been seeded. */
  | { readonly tag: 'not_configured'; readonly storeId: string }
  | { readonly tag: 'phone_invalid'; readonly reason: PhoneError }
  | { readonly tag: 'vat_unparsable'; readonly input: string }
  | { readonly tag: 'delivery_fee_unparsable'; readonly region: Region; readonly input: string }
  /** The domain refused the result — out-of-range VAT, a negative fee, an empty name. */
  | { readonly tag: 'invalid'; readonly reason: StoreSettingsError };

export type UpdateStoreSettings = (
  form: StoreSettingsForm,
) => Promise<Result<StoreSettings, UpdateStoreSettingsError>>;

/**
 * Two decimal places, held as a whole number.
 *
 * Cents from an amount and basis points from a percentage are the same
 * arithmetic — "3.50" is 350 cents and "11.25" is 1125 basis points — so this is
 * one parser rather than two that could drift apart.
 *
 * It is the money parser because of what that parser is careful about: the
 * fractional digits are read as CHARACTERS, not through a float, so "11.15" does
 * not arrive as 11.149999999999999 and truncate to 1114. It also inherits the
 * refusal to guess at a comma — "11,5" is unparsable rather than silently
 * eleven-and-a-half or a hundred and fifteen.
 */
const hundredths = (input: string): Result<number, 'unparsable'> => {
  const parsed = parseAmount(input);
  return parsed.ok ? ok(parsed.value.cents) : err('unparsable');
};

export const makeUpdateStoreSettings =
  (deps: { repository: StoreSettingsRepository; storeId: string }): UpdateStoreSettings =>
  async (form) => {
    /*
     * Read first, and edit what is there.
     *
     * The alternative — build a whole StoreSettings from the form — would need
     * the form to carry the locales and the site URL as hidden fields, which is
     * both a bigger form and a way for a stale tab to write back settings that
     * were changed by a deploy in the meantime.
     */
    const current = await deps.repository.findByStoreId(deps.storeId);
    if (current === null) return err({ tag: 'not_configured', storeId: deps.storeId });

    // The shop's own number goes through the same door as a customer's: one
    // stored shape, every Lebanese way of typing it accepted.
    const phone = parseLebanesePhone(form.contactPhone);
    if (!phone.ok) return err({ tag: 'phone_invalid', reason: phone.error });

    const vat = hundredths(form.vatPercent);
    if (!vat.ok) return err({ tag: 'vat_unparsable', input: form.vatPercent });

    /*
     * Every governorate, and the FIRST failure names which one.
     *
     * "The delivery fee could not be read" on a screen with eight of them is a
     * message that sends the operator hunting. The region travels with the error
     * so the page can outline the box.
     */
    const fees: Partial<Record<Region, number>> = {};
    for (const region of REGIONS) {
      const typed = form.deliveryFees[region];
      const parsed = hundredths(typed);
      if (!parsed.ok) return err({ tag: 'delivery_fee_unparsable', region, input: typed });
      fees[region] = parsed.value;
    }

    // Blank is null, not "". The storefront hides the registry line rather than
    // printing an empty label, and it decides that by asking whether it is null.
    const registry = form.commercialRegistryNumber.trim();

    const settings = createStoreSettings({
      ...current,
      name: form.name,
      contactPhone: phone.value,
      commercialRegistryNumber: registry.length === 0 ? null : registry,
      vatBasisPoints: vat.value,
      // The loop above ran over REGIONS itself and returned on the first
      // failure, so reaching here means every governorate has a price.
      deliveryFees: fees as ByRegion<number>,
    });
    if (!settings.ok) return err({ tag: 'invalid', reason: settings.error });

    await deps.repository.save(settings.value);
    return ok(settings.value);
  };

/** The stored settings rendered back into form values. */
export const toForm = (settings: StoreSettings): StoreSettingsForm => ({
  name: settings.name,
  contactPhone: settings.contactPhone,
  commercialRegistryNumber: settings.commercialRegistryNumber ?? '',
  // Two decimals both ways: 1100 shows as "11.00" and reads back as 1100.
  vatPercent: (settings.vatBasisPoints / 100).toFixed(2),
  deliveryFees: mapRegions((region) => (settings.deliveryFees[region] / 100).toFixed(2)),
});

/** Build a full table from a function of the governorate. */
const mapRegions = <T>(of: (region: Region) => T): ByRegion<T> =>
  Object.fromEntries(REGIONS.map((region) => [region, of(region)])) as ByRegion<T>;
