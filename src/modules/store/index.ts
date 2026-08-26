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
  createMongoStoreSettingsRepository,
  ensureStoreIndexes,
} from './infrastructure/mongo-store-settings-repository';

export type { GetStoreSettings, GetStoreSettingsError } from './application/get-store-settings';
export type { SaveStoreSettings, SaveStoreSettingsError } from './application/save-store-settings';
export type { StoreSettingsRepository } from './contracts';
export type { Locale, StoreSettings, StoreSettingsError } from './domain/store-settings';
export {
  createStoreSettings,
  directionOf,
  isLocale,
  LOCALES,
  showsRegistryNumber,
  vatRate,
} from './domain/store-settings';

export type StoreModule = {
  readonly getStoreSettings: GetStoreSettings;
  readonly saveStoreSettings: SaveStoreSettings;
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
    ensureIndexes: () => ensureStoreIndexes(deps.db),
  };
};
