/**
 * Use case: write the store's settings.
 *
 * Used by the seeder today and by the Phase 3 settings screen later. It takes
 * raw input rather than a validated StoreSettings so that validation happens
 * here, once, on the way in — a caller cannot skip it by constructing the object
 * itself, because createStoreSettings is the only way to obtain one.
 */

import { err, ok, type Result } from '@platform/result';
import type { StoreSettingsRepository } from '../contracts';
import {
  createStoreSettings,
  type StoreSettings,
  type StoreSettingsError,
} from '../domain/store-settings';

export type SaveStoreSettingsError =
  | { readonly tag: 'invalid'; readonly reason: StoreSettingsError }
  | { readonly tag: 'wrong_tenant'; readonly expected: string; readonly received: string };

export type SaveStoreSettings = (
  input: StoreSettings,
) => Promise<Result<StoreSettings, SaveStoreSettingsError>>;

export const makeSaveStoreSettings =
  (deps: { repository: StoreSettingsRepository; storeId: string }): SaveStoreSettings =>
  async (input) => {
    // Multi-tenancy is enforced at the repository layer, but writing another
    // tenant's document is worth rejecting explicitly rather than silently
    // filtering — a mismatch here means a bug upstream, not a stray read.
    if (input.storeId !== deps.storeId) {
      return err({ tag: 'wrong_tenant', expected: deps.storeId, received: input.storeId });
    }

    const settings = createStoreSettings(input);
    if (!settings.ok) return err({ tag: 'invalid', reason: settings.error });

    await deps.repository.save(settings.value);
    return ok(settings.value);
  };
