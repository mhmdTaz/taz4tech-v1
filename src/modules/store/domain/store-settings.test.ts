import { describe, expect, it } from 'vitest';
import {
  createStoreSettings,
  type StoreSettings,
  showsRegistryNumber,
  vatRate,
} from './store-settings';

const valid: StoreSettings = {
  storeId: 'taz4tech',
  name: 'Taz4Tech',
  defaultLocale: 'en',
  locales: ['en', 'ar', 'fr'],
  siteUrl: 'https://taz4tech.com',
  contactPhone: '+96170123456',
  vatBasisPoints: 1100,
  commercialRegistryNumber: null,
};

describe('createStoreSettings', () => {
  it('accepts a well-formed store', () => {
    const result = createStoreSettings(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('Taz4Tech');
  });

  it('trims the name rather than storing a padded one', () => {
    const result = createStoreSettings({ ...valid, name: '  Taz4Tech  ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('Taz4Tech');
  });

  it('strips trailing slashes from the canonical URL', () => {
    const result = createStoreSettings({ ...valid, siteUrl: 'https://taz4tech.com//' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.siteUrl).toBe('https://taz4tech.com');
  });

  it('rejects an empty or whitespace-only name', () => {
    for (const name of ['', '   ']) {
      const result = createStoreSettings({ ...valid, name });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.tag).toBe('name_empty');
    }
  });

  it('rejects a store that offers no locales', () => {
    const result = createStoreSettings({ ...valid, locales: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('no_locales');
  });

  it('rejects a default locale the store does not actually offer', () => {
    const result = createStoreSettings({ ...valid, defaultLocale: 'fr', locales: ['en', 'ar'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe('default_locale_not_offered');
      if (result.error.tag === 'default_locale_not_offered') {
        expect(result.error.defaultLocale).toBe('fr');
      }
    }
  });

  it.each([-1, 10_001, 11.5, Number.NaN])('rejects a VAT rate of %s basis points', (bp) => {
    const result = createStoreSettings({ ...valid, vatBasisPoints: bp });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('vat_out_of_range');
  });

  it('accepts the boundary VAT values, 0% and 100%', () => {
    expect(createStoreSettings({ ...valid, vatBasisPoints: 0 }).ok).toBe(true);
    expect(createStoreSettings({ ...valid, vatBasisPoints: 10_000 }).ok).toBe(true);
  });

  it.each([
    '70123456',
    '0096170123456',
    '+0123456',
    '+9617',
    'not a phone',
    '',
    '+961701234567890123',
  ])('rejects %s as a contact phone', (contactPhone) => {
    const result = createStoreSettings({ ...valid, contactPhone });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('phone_not_e164');
  });

  it('accepts a well-formed E.164 number', () => {
    expect(createStoreSettings({ ...valid, contactPhone: '+96170123456' }).ok).toBe(true);
    expect(createStoreSettings({ ...valid, contactPhone: '+12025550123' }).ok).toBe(true);
  });
});

describe('vatRate', () => {
  it('converts basis points to the multiplier Money.applyRate expects', () => {
    expect(vatRate({ ...valid, vatBasisPoints: 1100 })).toBeCloseTo(0.11, 10);
    expect(vatRate({ ...valid, vatBasisPoints: 0 })).toBe(0);
    expect(vatRate({ ...valid, vatBasisPoints: 10_000 })).toBe(1);
  });
});

describe('showsRegistryNumber', () => {
  it('is hidden until the business is actually registered', () => {
    // Law 81/2018 Art. 31 requires seller identity, but an empty label is worse
    // than no label — it reads as a broken page rather than a pending filing.
    expect(showsRegistryNumber({ ...valid, commercialRegistryNumber: null })).toBe(false);
    expect(showsRegistryNumber({ ...valid, commercialRegistryNumber: '' })).toBe(false);
    expect(showsRegistryNumber({ ...valid, commercialRegistryNumber: '   ' })).toBe(false);
  });

  it('is shown once there is a number to show', () => {
    expect(showsRegistryNumber({ ...valid, commercialRegistryNumber: '1234567' })).toBe(true);
  });
});
