import { sameEverywhere } from '@platform/regions';
import { err, ok } from '@platform/result';
import { describe, expect, it, vi } from 'vitest';
import type { StoreSettingsRepository } from '../contracts';
import type { StoreSettings } from '../domain/store-settings';
import { makeEnsureStoreSettings } from './ensure-store-settings';
import { makeSaveStoreSettings } from './save-store-settings';

const settings = (overrides: Partial<StoreSettings> = {}): StoreSettings => ({
  storeId: 'taz4tech',
  name: 'Taz4Tech',
  defaultLocale: 'en',
  locales: ['en', 'ar', 'fr'],
  siteUrl: 'https://taz4tech.com',
  contactPhone: '+96170000000',
  vatBasisPoints: 1100,
  commercialRegistryNumber: null,
  deliveryFees: sameEverywhere(0),
  ...overrides,
});

const harness = (current: StoreSettings | null) => {
  const save = vi.fn(async (_s: StoreSettings) => undefined);
  const repository = {
    findByStoreId: vi.fn(async () => current),
    save,
  } satisfies StoreSettingsRepository;

  return {
    save,
    repository,
    run: makeEnsureStoreSettings({
      repository,
      save: makeSaveStoreSettings({ repository, storeId: 'taz4tech' }),
      storeId: 'taz4tech',
    }),
  };
};

describe('bringing a store into existence', () => {
  it('writes the defaults when there are no settings', async () => {
    const h = harness(null);
    const result = await h.run(settings());

    expect(result).toMatchObject({ ok: true, value: { tag: 'created' } });
    expect(h.save).toHaveBeenCalledOnce();
  });

  it('refuses defaults the domain would reject, rather than writing them', async () => {
    const h = harness(null);
    const result = await h.run(settings({ name: '  ' }));

    expect(result).toEqual({
      ok: false,
      error: { tag: 'invalid', reason: { tag: 'name_empty' } },
    });
    expect(h.save).not.toHaveBeenCalled();
  });

  it('refuses defaults for another tenant', async () => {
    const h = harness(null);
    const result = await h.run(settings({ storeId: 'somebody-else' }));

    expect(result.ok).toBe(false);
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe('when the store is already configured', () => {
  it('WRITES NOTHING', async () => {
    /*
     * The whole reason this use case exists. The shop's name, phone, VAT rate and
     * eight delivery prices are edited in the admin; a seeder that rewrites them
     * from constants turns "run the seed again" into "undo everything anyone
     * configured", silently.
     */
    const h = harness(settings({ name: 'Taz4Tech Electronics' }));
    await h.run(settings({ name: 'Taz4Tech' }));

    expect(h.save).not.toHaveBeenCalled();
  });

  it('reports what is STORED, not what was offered', async () => {
    // An operator reading the seed output has to see the shop as it is, or the
    // script has told them a comforting fiction about a database it did not read.
    const stored = settings({
      name: 'Taz4Tech Electronics',
      deliveryFees: { ...sameEverywhere(300), beirut: 200 },
    });
    const h = harness(stored);

    const result = await h.run(settings({ name: 'Taz4Tech' }));

    expect(result).toEqual({ ok: true, value: { tag: 'already_there', settings: stored } });
  });

  it('leaves edited delivery prices alone', async () => {
    // Named separately because these are the ones that cost money: a seed that
    // reset them would go back to charging nothing for every delivery.
    const h = harness(settings({ deliveryFees: { ...sameEverywhere(400), akkar: 800 } }));
    const result = await h.run(settings({ deliveryFees: sameEverywhere(0) }));

    expect(h.save).not.toHaveBeenCalled();
    expect(result.ok && result.value.settings.deliveryFees.akkar).toBe(800);
  });
});

describe('overwriting is still possible', () => {
  it('but only by asking for it by name', async () => {
    // `saveStoreSettings` is the door a test database goes through. It is a
    // different function on purpose: nobody reaches it by accident.
    const repository = {
      findByStoreId: vi.fn(async () => settings({ name: 'Edited' })),
      save: vi.fn(async (_s: StoreSettings) => undefined),
    } satisfies StoreSettingsRepository;

    const save = makeSaveStoreSettings({ repository, storeId: 'taz4tech' });
    expect(await save(settings({ name: 'Taz4Tech' }))).toEqual(ok(settings({ name: 'Taz4Tech' })));
    expect(repository.save).toHaveBeenCalledOnce();
  });
});

describe('when the write fails', () => {
  it('passes the reason through rather than claiming a store was created', async () => {
    const repository = {
      findByStoreId: vi.fn(async () => null),
      save: vi.fn(async (_s: StoreSettings) => undefined),
    } satisfies StoreSettingsRepository;

    const run = makeEnsureStoreSettings({
      repository,
      save: vi.fn(async () => err({ tag: 'wrong_tenant' as const, expected: 'a', received: 'b' })),
      storeId: 'taz4tech',
    });

    expect(await run(settings())).toEqual({
      ok: false,
      error: { tag: 'wrong_tenant', expected: 'a', received: 'b' },
    });
  });
});
