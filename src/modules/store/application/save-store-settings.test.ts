import { sameEverywhere } from '@platform/regions';
import { describe, expect, it, vi } from 'vitest';
import type { StoreSettingsRepository } from '../contracts';
import type { StoreSettings } from '../domain/store-settings';
import { makeSaveStoreSettings } from './save-store-settings';

const settings: StoreSettings = {
  storeId: 'taz4tech',
  name: 'Taz4Tech',
  contactPhone: '+96170123456',
  vatBasisPoints: 1100,
  commercialRegistryNumber: null,
  deliveryFees: sameEverywhere(0),
};

const repository = (): StoreSettingsRepository => ({
  findByStoreId: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(undefined),
});

describe('saveStoreSettings', () => {
  it('validates, saves, and returns the normalised settings', async () => {
    const repo = repository();
    const save = makeSaveStoreSettings({ repository: repo, storeId: 'taz4tech' });

    const result = await save({ ...settings, name: '  Taz4Tech  ' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('Taz4Tech');
    // The repository receives the trimmed value, never the raw input.
    expect(repo.save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'Taz4Tech' }),
    );
  });

  it('refuses to write another tenant’s document', async () => {
    const repo = repository();
    const save = makeSaveStoreSettings({ repository: repo, storeId: 'taz4tech' });

    const result = await save({ ...settings, storeId: 'someone-else' });

    expect(result).toMatchObject({
      ok: false,
      error: { tag: 'wrong_tenant', expected: 'taz4tech', received: 'someone-else' },
    });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rejects input the domain considers invalid, without touching the database', async () => {
    const repo = repository();
    const save = makeSaveStoreSettings({ repository: repo, storeId: 'taz4tech' });

    const result = await save({ ...settings, contactPhone: '70123456' });

    expect(result).toMatchObject({
      ok: false,
      error: { tag: 'invalid', reason: { tag: 'phone_not_e164' } },
    });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('checks the tenant before validating, so a cross-tenant write is never merely invalid', async () => {
    const repo = repository();
    const save = makeSaveStoreSettings({ repository: repo, storeId: 'taz4tech' });

    const result = await save({ ...settings, storeId: 'other', contactPhone: 'nonsense' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('wrong_tenant');
  });

  it('lets a repository failure propagate', async () => {
    const repo: StoreSettingsRepository = {
      findByStoreId: vi.fn(),
      save: vi.fn().mockRejectedValue(new Error('write concern timeout')),
    };
    const save = makeSaveStoreSettings({ repository: repo, storeId: 'taz4tech' });

    await expect(save(settings)).rejects.toThrow('write concern timeout');
  });
});
