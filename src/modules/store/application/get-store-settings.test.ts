import { sameEverywhere } from '@platform/regions';
import { describe, expect, it, vi } from 'vitest';
import type { StoreSettingsRepository } from '../contracts';
import type { StoreSettings } from '../domain/store-settings';
import { makeGetStoreSettings } from './get-store-settings';

const settings: StoreSettings = {
  storeId: 'taz4tech',
  name: 'Taz4Tech',
  contactPhone: '+96170123456',
  vatBasisPoints: 1100,
  commercialRegistryNumber: null,
  deliveryFees: sameEverywhere(0),
};

const repositoryReturning = (value: StoreSettings | null): StoreSettingsRepository => ({
  findByStoreId: vi.fn().mockResolvedValue(value),
  save: vi.fn().mockResolvedValue(undefined),
});

describe('getStoreSettings', () => {
  it('returns the settings for the configured store', async () => {
    const getStoreSettings = makeGetStoreSettings({
      repository: repositoryReturning(settings),
      storeId: 'taz4tech',
    });

    const result = await getStoreSettings();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(settings);
  });

  it('asks the repository for the tenant it was wired with, never for anything else', async () => {
    // The storeId comes from configuration at composition time, so no caller can
    // pass one in — which is what makes cross-tenant reads impossible by design
    // rather than by review.
    const repository = repositoryReturning(settings);
    await makeGetStoreSettings({ repository, storeId: 'other-tenant' })();
    expect(repository.findByStoreId).toHaveBeenCalledExactlyOnceWith('other-tenant');
  });

  it('reports store_not_configured when the store has not been seeded', async () => {
    const getStoreSettings = makeGetStoreSettings({
      repository: repositoryReturning(null),
      storeId: 'taz4tech',
    });

    const result = await getStoreSettings();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe('store_not_configured');
      expect(result.error.storeId).toBe('taz4tech');
    }
  });

  it('lets an unexpected repository failure propagate rather than swallowing it', async () => {
    // Atlas being unreachable is not an expected outcome of this use case, so it
    // is a throw, not an Err. Turning it into an Err here would make "store not
    // configured" and "database down" indistinguishable to the caller.
    const repository: StoreSettingsRepository = {
      findByStoreId: vi.fn().mockRejectedValue(new Error('connection refused')),
      save: vi.fn(),
    };
    const getStoreSettings = makeGetStoreSettings({ repository, storeId: 'taz4tech' });

    await expect(getStoreSettings()).rejects.toThrow('connection refused');
  });
});
