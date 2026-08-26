/**
 * Use case: read the current store's settings.
 *
 * This is the layer that carries the genuine 100% coverage requirement. Async
 * Server Components cannot be unit tested (Next.js says so outright), so every
 * decision has to live here, where it is testable with no framework at all — the
 * page component is left with nothing to do but render the result.
 */

import { err, ok, type Result } from '@platform/result';
import type { StoreSettingsRepository } from '../contracts';
import type { StoreSettings } from '../domain/store-settings';

export type GetStoreSettingsError =
  | { readonly tag: 'store_not_configured'; readonly storeId: string }
  | { readonly tag: 'lookup_failed'; readonly storeId: string };

export type GetStoreSettings = () => Promise<Result<StoreSettings, GetStoreSettingsError>>;

export const makeGetStoreSettings =
  (deps: { repository: StoreSettingsRepository; storeId: string }): GetStoreSettings =>
  async () => {
    const settings = await deps.repository.findByStoreId(deps.storeId);
    if (settings === null) return err({ tag: 'store_not_configured', storeId: deps.storeId });
    return ok(settings);
  };
