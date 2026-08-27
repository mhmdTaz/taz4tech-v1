/**
 * Use case: make sure a store HAS settings, without deciding what they say.
 *
 * The distinction between this and `saveStoreSettings` is the whole point.
 * `save` writes what it is given, every field, every time — which is what the
 * settings screen wants and what a seeder must not do.
 *
 * WHY A SEEDER MUST NOT OVERWRITE
 * -------------------------------
 * The shop's name, its phone number, the VAT rate and the eight delivery prices
 * are edited by an operator in the admin. They are the sort of thing that gets
 * changed once, quietly, and then relied on. A seed script that rewrites them
 * from constants in a file turns "run the seed again" — something anyone would
 * do to a database that looks empty, or that a deploy runbook might do on every
 * release — into "undo everything anyone configured", with no error and no
 * mention of it in the output.
 *
 * So the defaults handed in here are exactly that: defaults, used to bring a
 * store into existence and ignored ever after. Overwriting is still possible and
 * still needed — a test database has to be put back to a known state — but it is
 * `saveStoreSettings`, asked for by name.
 */

import { err, ok, type Result } from '@platform/result';
import type { StoreSettingsRepository } from '../contracts';
import type { StoreSettings } from '../domain/store-settings';
import type { SaveStoreSettings, SaveStoreSettingsError } from './save-store-settings';

export type EnsureStoreSettingsOutcome =
  | { readonly tag: 'created'; readonly settings: StoreSettings }
  /** Already configured. The settings returned are the STORED ones, not the defaults. */
  | { readonly tag: 'already_there'; readonly settings: StoreSettings };

export type EnsureStoreSettings = (
  defaults: StoreSettings,
) => Promise<Result<EnsureStoreSettingsOutcome, SaveStoreSettingsError>>;

export const makeEnsureStoreSettings =
  (deps: {
    repository: StoreSettingsRepository;
    save: SaveStoreSettings;
    storeId: string;
  }): EnsureStoreSettings =>
  async (defaults) => {
    const current = await deps.repository.findByStoreId(deps.storeId);
    if (current !== null) return ok({ tag: 'already_there', settings: current });

    // Through `save`, not straight to the repository: the tenant check and the
    // domain validation are written once, and a seeder gets them for free.
    const saved = await deps.save(defaults);
    return saved.ok ? ok({ tag: 'created', settings: saved.value }) : err(saved.error);
  };
