import { REGIONS, sameEverywhere } from '@platform/regions';
import { describe, expect, it } from 'vitest';
import {
  createStoreSettings,
  deliveryFeeFor,
  deliverySpread,
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
  deliveryFees: sameEverywhere(0),
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

describe('the delivery table', () => {
  it('accepts zero everywhere, which is what a shop with free delivery sets', () => {
    expect(createStoreSettings({ ...valid, deliveryFees: sameEverywhere(0) }).ok).toBe(true);
  });

  it('accepts a different price for every governorate', () => {
    // The whole point: Beirut is not Akkar.
    const fees = { ...sameEverywhere(300), beirut: 200, akkar: 800 };
    const result = createStoreSettings({ ...valid, deliveryFees: fees });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(deliveryFeeFor(result.value, 'beirut')).toBe(200);
      expect(deliveryFeeFor(result.value, 'akkar')).toBe(800);
      expect(deliveryFeeFor(result.value, 'south')).toBe(300);
    }
  });

  it('refuses a fractional fee, naming the governorate', () => {
    // Money everywhere in this system is integer cents. A fraction here is a
    // caller that computed one from a float, which is the bug this catches.
    expect(
      createStoreSettings({ ...valid, deliveryFees: { ...sameEverywhere(0), bekaa: 2.5 } }),
    ).toEqual({
      ok: false,
      error: { tag: 'delivery_fee_invalid', region: 'bekaa', deliveryFeeCents: 2.5 },
    });
  });

  it('refuses a negative fee, which would be a discount by accident', () => {
    const fees = { ...sameEverywhere(0), north: -100 };
    expect(createStoreSettings({ ...valid, deliveryFees: fees }).ok).toBe(false);
  });

  it('refuses a table with a governorate missing', () => {
    /*
     * The reason the table is complete rather than partial. A missing price is
     * `undefined` cents, and `undefined` added to a subtotal is NaN on a receipt
     * — a failure that reaches the customer rather than the developer.
     */
    const { nabatieh: _dropped, ...incomplete } = sameEverywhere(0);
    const result = createStoreSettings({
      ...valid,
      deliveryFees: incomplete as StoreSettings['deliveryFees'],
    });

    expect(result).toEqual({
      ok: false,
      error: { tag: 'delivery_fee_invalid', region: 'nabatieh', deliveryFeeCents: undefined },
    });
  });

  it('checks every governorate, not just the first', () => {
    // A loop that returned after one check would pass this and ship a shop that
    // gives Nabatieh its deliveries free.
    const fees = { ...sameEverywhere(300), nabatieh: -1 };
    expect(createStoreSettings({ ...valid, deliveryFees: fees }).ok).toBe(false);
  });
});

describe('the spread of the table', () => {
  it('is a single number when every governorate costs the same', () => {
    // What a flat rate looks like here — and what lets checkout quote an exact
    // total before the customer has chosen where they live.
    const result = createStoreSettings({ ...valid, deliveryFees: sameEverywhere(250) });
    expect(result.ok && deliverySpread(result.value)).toEqual({ min: 250, max: 250 });
  });

  it('reports the cheapest and the dearest when they differ', () => {
    const fees = { ...sameEverywhere(300), beirut: 100, akkar: 900 };
    const result = createStoreSettings({ ...valid, deliveryFees: fees });
    expect(result.ok && deliverySpread(result.value)).toEqual({ min: 100, max: 900 });
  });

  it('looks at all eight, wherever the extremes sit in the list', () => {
    // The last governorate in the list, so a spread that only read the first few
    // would report 500 and let checkout quote a delivery nobody offers.
    const last = REGIONS[REGIONS.length - 1] ?? 'beirut';
    const fees = { ...sameEverywhere(500), [last]: 50 };
    const result = createStoreSettings({ ...valid, deliveryFees: fees });

    expect(result.ok && deliverySpread(result.value).min).toBe(50);
  });
});
