/**
 * Store settings — the tenant's own description of itself.
 *
 * Framework-free and IO-free by construction: this file may not import next,
 * react, or the mongo driver, and the boundary check enforces that. It is the
 * layer mutation testing runs against, so every branch here has to matter.
 */

import { err, ok, type Result } from '@platform/result';

export const LOCALES = ['en', 'ar', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value);

/** ar is written right-to-left; en and fr are not. Drives dir= on <html>. */
export const directionOf = (locale: Locale): 'ltr' | 'rtl' => (locale === 'ar' ? 'rtl' : 'ltr');

export type StoreSettings = {
  readonly storeId: string;
  readonly name: string;
  readonly defaultLocale: Locale;
  readonly locales: readonly Locale[];
  /** Canonical origin without a trailing slash. */
  readonly siteUrl: string;
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
};

export type StoreSettingsError =
  | { readonly tag: 'name_empty' }
  | { readonly tag: 'no_locales' }
  | { readonly tag: 'default_locale_not_offered'; readonly defaultLocale: Locale }
  | { readonly tag: 'vat_out_of_range'; readonly vatBasisPoints: number }
  | { readonly tag: 'phone_not_e164'; readonly contactPhone: string };

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * The only way to obtain a StoreSettings. Every invariant is checked here, so a
 * value of this type is trustworthy everywhere else without re-validation.
 */
export const createStoreSettings = (
  input: StoreSettings,
): Result<StoreSettings, StoreSettingsError> => {
  if (input.name.trim().length === 0) return err({ tag: 'name_empty' });
  if (input.locales.length === 0) return err({ tag: 'no_locales' });
  if (!input.locales.includes(input.defaultLocale)) {
    return err({ tag: 'default_locale_not_offered', defaultLocale: input.defaultLocale });
  }
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
  return ok({ ...input, name: input.name.trim(), siteUrl: input.siteUrl.replace(/\/+$/, '') });
};

/** VAT as a multiplier for Money.applyRate — 1100 bp becomes 0.11. */
export const vatRate = (settings: StoreSettings): number => settings.vatBasisPoints / 10_000;

/** Law 81/2018 Art. 31: show seller identity only once there is one to show. */
export const showsRegistryNumber = (settings: StoreSettings): boolean =>
  settings.commercialRegistryNumber !== null && settings.commercialRegistryNumber.trim().length > 0;
