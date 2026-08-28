/**
 * Store settings — the tenant's own description of itself.
 *
 * Framework-free and IO-free by construction: this file may not import next,
 * react, or the mongo driver, and the boundary check enforces that. It is the
 * layer mutation testing runs against, so every branch here has to matter.
 */

import { type ByRegion, REGIONS, type Region } from '@platform/regions';
import { err, ok, type Result } from '@platform/result';

/*
 * WHAT IS NOT HERE, AND WHY
 * -------------------------
 * `siteUrl`, `locales` and `defaultLocale` used to live on this type. Nothing
 * ever read them. Canonical links are built from `SITE_URL` on the deploy, and
 * routing is built from the compiled-in locale list — so the stored copies were
 * three values that looked authoritative, could drift from the real ones, and
 * governed nothing. The settings screen showed the REAL values beside them,
 * which is the clearest sign they were furniture.
 *
 * They are dropped rather than wired up: a shop that could change its own
 * locales at runtime would need routing, the sitemap and every hreflang to
 * follow, which is a deploy either way.
 */
export type StoreSettings = {
  readonly storeId: string;
  readonly name: string;
  /** E.164, the identity anchor for the whole system. */
  readonly contactPhone: string;
  /**
   * VAT, in basis points (1100 = 11%). Integer to keep tax exact; see Money.
   *
   * Lebanon's rate is 11% and registration is tied to an LBP 5bn threshold.
   * Advisory sources claim importers must register regardless of turnover, but
   * that is not primary-sourced — treat this field as configurable, not settled.
   */
  readonly vatBasisPoints: number;
  /**
   * Commercial registry number. Law 81/2018 Art. 31 requires seller identity on
   * the storefront. Absent until the business is registered, and the footer
   * hides the line rather than printing an empty label.
   */
  readonly commercialRegistryNumber: string | null;
  /**
   * Delivery, in integer cents, per governorate.
   *
   * Complete: every one of the eight, no default and no gaps. A partial table
   * needs a fallback, and a fallback is a second answer to "what does delivery
   * to Akkar cost" — which is how a checkout quotes one number and an order
   * charges another. A shop with one price everywhere writes it eight times,
   * which is cheap; a shop with a wrong price for one governorate is not.
   */
  readonly deliveryFees: ByRegion<number>;
};

export type StoreSettingsError =
  | { readonly tag: 'name_empty' }
  | { readonly tag: 'vat_out_of_range'; readonly vatBasisPoints: number }
  | { readonly tag: 'phone_not_e164'; readonly contactPhone: string }
  | {
      readonly tag: 'delivery_fee_invalid';
      readonly region: Region;
      readonly deliveryFeeCents: number;
    };

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * The only way to obtain a StoreSettings. Every invariant is checked here, so a
 * value of this type is trustworthy everywhere else without re-validation.
 */
export const createStoreSettings = (
  input: StoreSettings,
): Result<StoreSettings, StoreSettingsError> => {
  if (input.name.trim().length === 0) return err({ tag: 'name_empty' });
  if (
    !Number.isInteger(input.vatBasisPoints) ||
    input.vatBasisPoints < 0 ||
    input.vatBasisPoints > 10_000
  ) {
    return err({ tag: 'vat_out_of_range', vatBasisPoints: input.vatBasisPoints });
  }
  if (!E164.test(input.contactPhone)) {
    return err({ tag: 'phone_not_e164', contactPhone: input.contactPhone });
  }
  // Money everywhere in this system is integer cents. A fractional fee is a
  // caller that computed one from a float, which is the bug this catches.
  //
  // Every governorate is checked, not just the ones that happen to be present:
  // a table missing Akkar reads as `undefined` cents, and `undefined` added to a
  // subtotal is NaN on a receipt.
  for (const region of REGIONS) {
    const cents = input.deliveryFees[region];
    if (!Number.isInteger(cents) || cents < 0) {
      return err({ tag: 'delivery_fee_invalid', region, deliveryFeeCents: cents });
    }
  }
  return ok({ ...input, name: input.name.trim() });
};

/** VAT as a multiplier for Money.applyRate — 1100 bp becomes 0.11. */
export const vatRate = (settings: StoreSettings): number => settings.vatBasisPoints / 10_000;

/** Law 81/2018 Art. 31: show seller identity only once there is one to show. */
export const showsRegistryNumber = (settings: StoreSettings): boolean =>
  settings.commercialRegistryNumber !== null && settings.commercialRegistryNumber.trim().length > 0;

/** What delivery costs to one governorate. Total, because the table is complete. */
export const deliveryFeeFor = (settings: StoreSettings, region: Region): number =>
  settings.deliveryFees[region];

/**
 * The cheapest and dearest delivery in the table.
 *
 * The checkout page uses it to decide whether it can quote an exact total before
 * the customer has chosen a governorate. When every governorate costs the same —
 * which is what a flat rate looks like here — it can. When they differ, quoting
 * one number would be picking a governorate on the customer's behalf.
 */
export const deliverySpread = (
  settings: StoreSettings,
): { readonly min: number; readonly max: number } => {
  const fees = REGIONS.map((region) => settings.deliveryFees[region]);
  return { min: Math.min(...fees), max: Math.max(...fees) };
};
