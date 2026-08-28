import { sameEverywhere } from '@platform/regions';
import { describe, expect, it, vi } from 'vitest';
import type { StoreSettingsRepository } from '../contracts';
import type { StoreSettings } from '../domain/store-settings';
import { makeUpdateStoreSettings, type StoreSettingsForm, toForm } from './update-store-settings';

const stored = (overrides: Partial<StoreSettings> = {}): StoreSettings => ({
  storeId: 'taz4tech',
  name: 'Taz4Tech',
  contactPhone: '+96170000000',
  vatBasisPoints: 1100,
  commercialRegistryNumber: null,
  deliveryFees: sameEverywhere(0),
  ...overrides,
});

const form = (overrides: Partial<StoreSettingsForm> = {}): StoreSettingsForm => ({
  name: 'Taz4Tech',
  contactPhone: '70 000 000',
  commercialRegistryNumber: '',
  vatPercent: '11',
  deliveryFees: sameEverywhere('0'),
  ...overrides,
});

const harness = (current: StoreSettings | null = stored()) => {
  const save = vi.fn(async (_settings: StoreSettings) => undefined);
  const repository = {
    findByStoreId: vi.fn(async () => current),
    save,
  } satisfies StoreSettingsRepository;

  return {
    save,
    repository,
    run: makeUpdateStoreSettings({ repository, storeId: 'taz4tech' }),
    /** The settings that were actually written. */
    written: (): StoreSettings | undefined => save.mock.calls[0]?.[0],
  };
};

describe('editing the settings', () => {
  it('saves the fields the form covers', async () => {
    const h = harness();
    const result = await h.run(
      form({ name: 'Taz4Tech Electronics', commercialRegistryNumber: 'CR-12345' }),
    );

    expect(result.ok).toBe(true);
    expect(h.written()).toMatchObject({
      name: 'Taz4Tech Electronics',
      commercialRegistryNumber: 'CR-12345',
    });
  });

  it('carries through every field the form does NOT cover', async () => {
    /*
     * The locales and the site URL are decided at build and deploy time. An edit
     * that quietly rewrote them from a form would be the settings screen telling
     * the operator it controls something it does not.
     */
    const h = harness();
    await h.run(form());

    expect(h.written()).toMatchObject({
      storeId: 'taz4tech',
    });
  });

  it('reports a store that has never been seeded rather than creating one', async () => {
    // Creating settings from a half-filled form would invent a shop. The seeder
    // is the thing that brings a store into existence.
    const h = harness(null);

    expect(await h.run(form())).toEqual({
      ok: false,
      error: { tag: 'not_configured', storeId: 'taz4tech' },
    });
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe('the phone number', () => {
  it('normalises whatever the operator typed', async () => {
    // The shop's own number goes through the same door as a customer's, so the
    // storefront never shows two spellings of one number.
    const h = harness();
    await h.run(form({ contactPhone: '03 123 456' }));

    expect(h.written()?.contactPhone).toBe('+9613123456');
  });

  it('accepts the international form of the same number', async () => {
    const h = harness();
    await h.run(form({ contactPhone: '+961 3 123 456' }));

    expect(h.written()?.contactPhone).toBe('+9613123456');
  });

  it('refuses a number it cannot read, and writes nothing', async () => {
    const h = harness();
    const result = await h.run(form({ contactPhone: 'call the shop' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('phone_invalid');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('refuses a number this shop could not call', async () => {
    const h = harness();
    const result = await h.run(form({ contactPhone: '+44 20 7123 4567' }));

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.tag === 'phone_invalid') {
      expect(result.error.reason.tag).toBe('not_lebanese');
    }
  });
});

describe('the VAT rate', () => {
  it('reads a whole percentage as basis points', async () => {
    const h = harness();
    await h.run(form({ vatPercent: '11' }));

    expect(h.written()?.vatBasisPoints).toBe(1100);
  });

  it('reads a fractional percentage EXACTLY', async () => {
    /*
     * The reason this goes through the money parser. 11.15 as a float is
     * 11.149999999999999, and a naive round-trip truncates it to 1114 basis
     * points — a rate that is quietly wrong on every invoice.
     */
    const h = harness();
    await h.run(form({ vatPercent: '11.15' }));

    expect(h.written()?.vatBasisPoints).toBe(1115);
  });

  it('accepts zero, for a store that is not registered for VAT', async () => {
    const h = harness();
    const result = await h.run(form({ vatPercent: '0' }));

    expect(result.ok).toBe(true);
    expect(h.written()?.vatBasisPoints).toBe(0);
  });

  it('refuses a rate it cannot read', async () => {
    const h = harness();
    expect(await h.run(form({ vatPercent: 'eleven' }))).toEqual({
      ok: false,
      error: { tag: 'vat_unparsable', input: 'eleven' },
    });
  });

  it('refuses an ambiguous comma rather than guessing', async () => {
    // "11,5" is eleven and a half to a French writer and could be read as a
    // thousands separator otherwise. Nothing in the field says which.
    const h = harness();
    const result = await h.run(form({ vatPercent: '11,5' }));

    expect(result.ok).toBe(false);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('refuses a rate above 100%', async () => {
    // Caught by the domain, not here — this asserts the two are actually wired.
    const h = harness();
    const result = await h.run(form({ vatPercent: '150' }));

    expect(result).toEqual({
      ok: false,
      error: { tag: 'invalid', reason: { tag: 'vat_out_of_range', vatBasisPoints: 15_000 } },
    });
  });

  it('refuses a negative rate', async () => {
    const h = harness();
    const result = await h.run(form({ vatPercent: '-1' }));

    expect(result.ok).toBe(false);
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe('the delivery table', () => {
  it('reads an amount as cents, for every governorate', async () => {
    const h = harness();
    await h.run(form({ deliveryFees: sameEverywhere('3.50') }));

    expect(h.written()?.deliveryFees.beirut).toBe(350);
    expect(h.written()?.deliveryFees.nabatieh).toBe(350);
  });

  it('prices each governorate separately', async () => {
    // The whole point of the change: Beirut is not Akkar.
    const h = harness();
    await h.run(
      form({ deliveryFees: { ...sameEverywhere('3.00'), beirut: '2.00', akkar: '8.00' } }),
    );

    expect(h.written()?.deliveryFees).toMatchObject({
      beirut: 200,
      akkar: 800,
      south: 300,
    });
  });

  it('accepts an amount written with a dollar sign', async () => {
    const h = harness();
    await h.run(form({ deliveryFees: sameEverywhere('$3.50') }));

    expect(h.written()?.deliveryFees.bekaa).toBe(350);
  });

  it('accepts zero, which is free delivery', async () => {
    const h = harness(stored({ deliveryFees: sameEverywhere(500) }));
    const result = await h.run(form({ deliveryFees: sameEverywhere('0') }));

    expect(result.ok).toBe(true);
    expect(h.written()?.deliveryFees.north).toBe(0);
  });

  it('refuses an amount it cannot read, and says WHICH governorate', async () => {
    // "The delivery fee could not be read" on a screen with eight of them is a
    // message that sends the operator hunting.
    const h = harness();
    const result = await h.run(
      form({ deliveryFees: { ...sameEverywhere('3.00'), baalbek_hermel: 'free' } }),
    );

    expect(result).toEqual({
      ok: false,
      error: { tag: 'delivery_fee_unparsable', region: 'baalbek_hermel', input: 'free' },
    });
    expect(h.save).not.toHaveBeenCalled();
  });

  it('refuses a negative fee', async () => {
    // A negative delivery fee is a discount nobody asked for, applied to every
    // order going to that governorate.
    const h = harness();
    const result = await h.run(form({ deliveryFees: { ...sameEverywhere('0'), akkar: '-2.00' } }));

    expect(result).toEqual({
      ok: false,
      error: {
        tag: 'invalid',
        reason: { tag: 'delivery_fee_invalid', region: 'akkar', deliveryFeeCents: -200 },
      },
    });
    expect(h.save).not.toHaveBeenCalled();
  });

  it('writes nothing when one governorate out of eight is wrong', async () => {
    // All or nothing. Saving seven prices and refusing the eighth would leave the
    // shop charging a mixture of what the operator meant and what it used to be.
    const h = harness(stored({ deliveryFees: sameEverywhere(100) }));
    await h.run(form({ deliveryFees: { ...sameEverywhere('9.99'), south: 'nope' } }));

    expect(h.save).not.toHaveBeenCalled();
  });
});

describe('the registry number', () => {
  it('stores null when the field is left blank', async () => {
    // The storefront hides the line rather than printing an empty label, and it
    // decides that by asking whether the value is null.
    const h = harness({ ...stored(), commercialRegistryNumber: 'CR-999' });
    await h.run(form({ commercialRegistryNumber: '   ' }));

    expect(h.written()?.commercialRegistryNumber).toBeNull();
  });

  it('trims what was typed', async () => {
    const h = harness();
    await h.run(form({ commercialRegistryNumber: '  CR-12345  ' }));

    expect(h.written()?.commercialRegistryNumber).toBe('CR-12345');
  });
});

describe('the name', () => {
  it('refuses an empty one', async () => {
    const h = harness();
    expect(await h.run(form({ name: '   ' }))).toEqual({
      ok: false,
      error: { tag: 'invalid', reason: { tag: 'name_empty' } },
    });
  });

  it('trims it, so the storefront does not render a leading space', async () => {
    const h = harness();
    await h.run(form({ name: '  Taz4Tech  ' }));

    expect(h.written()?.name).toBe('Taz4Tech');
  });
});

describe('rendering the stored settings back into the form', () => {
  it('shows a rate and every fee with two decimals', async () => {
    const rendered = toForm(
      stored({ vatBasisPoints: 1100, deliveryFees: { ...sameEverywhere(350), beirut: 200 } }),
    );

    expect(rendered.vatPercent).toBe('11.00');
    expect(rendered.deliveryFees.beirut).toBe('2.00');
    expect(rendered.deliveryFees.akkar).toBe('3.50');
  });

  it('round-trips: what it renders is what the parser reads back', async () => {
    // The property that matters. A form that renders "11" and parses "1100" is
    // fine; one that renders a value it cannot read is a screen that refuses to
    // save until the operator edits a field they never meant to touch.
    const original = stored({
      vatBasisPoints: 1115,
      deliveryFees: { ...sameEverywhere(275), beirut: 0, akkar: 1250 },
    });
    const h = harness(original);

    await h.run({ ...toForm(original) });

    expect(h.written()).toMatchObject({ vatBasisPoints: 1115 });
    expect(h.written()?.deliveryFees).toEqual(original.deliveryFees);
  });

  it('renders an absent registry number as an empty field', async () => {
    expect(toForm(stored()).commercialRegistryNumber).toBe('');
  });
});
