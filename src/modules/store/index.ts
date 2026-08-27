/**
 * Public surface of the store module.
 *
 * Everything the rest of the system may know about this module is on this page.
 * The boundary check rejects any import that reaches past it — which is what
 * makes the folders behind it free to change.
 */

import type { Db } from '@platform/mongo';
import { type GetStoreSettings, makeGetStoreSettings } from './application/get-store-settings';
import { makeSaveStoreSettings, type SaveStoreSettings } from './application/save-store-settings';
import {
  makeUpdateStoreSettings,
  type UpdateStoreSettings,
} from './application/update-store-settings';
import {
  createMongoStoreSettingsRepository,
  ensureStoreIndexes,
} from './infrastructure/mongo-store-settings-repository';

export type { GetStoreSettings, GetStoreSettingsError } from './application/get-store-settings';
export type { SaveStoreSettings, SaveStoreSettingsError } from './application/save-store-settings';
export type {
  StoreSettingsForm,
  UpdateStoreSettings,
  UpdateStoreSettingsError,
} from './application/update-store-settings';
export { toForm } from './application/update-store-settings';
export type { StoreSettingsRepository } from './contracts';
export type { StoreSettings, StoreSettingsError } from './domain/store-settings';
export {
  createStoreSettings,
  deliveryFeeFor,
  deliverySpread,
  showsRegistryNumber,
  vatRate,
} from './domain/store-settings';

export type StoreModule = {
  readonly getStoreSettings: GetStoreSettings;
  readonly saveStoreSettings: SaveStoreSettings;
  /** The admin settings screen: raw form strings in, validated settings out. */
  readonly updateStoreSettings: UpdateStoreSettings;
  readonly ensureIndexes: () => Promise<void>;
};

/**
 * Build the module. The composition root passes in platform services and gets
 * back use cases — it never sees the repository or the collection name.
 */
export const createStoreModule = (deps: { db: Db; storeId: string }): StoreModule => {
  const repository = createMongoStoreSettingsRepository(deps.db);
  const wiring = { repository, storeId: deps.storeId };

  return {
    getStoreSettings: makeGetStoreSettings(wiring),
    saveStoreSettings: makeSaveStoreSettings(wiring),
    updateStoreSettings: makeUpdateStoreSettings(wiring),
    ensureIndexes: () => ensureStoreIndexes(deps.db),
  };
};
