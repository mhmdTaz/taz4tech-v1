/**
 * Ports. The application layer depends on these interfaces; infrastructure
 * implements them. The direction of that dependency is the whole point — swapping
 * Mongo for anything else touches one folder.
 */

import type { StoreSettings } from '../domain/store-settings';

export interface StoreSettingsRepository {
  /** The settings for one tenant, or null when the store has not been seeded. */
  findByStoreId(storeId: string): Promise<StoreSettings | null>;
  /** Idempotent upsert, used by the seeder and the Phase 3 settings screen. */
  save(settings: StoreSettings): Promise<void>;
}
