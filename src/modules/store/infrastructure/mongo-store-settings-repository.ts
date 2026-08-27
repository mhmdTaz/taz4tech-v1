/**
 * Mongo adapter for StoreSettingsRepository.
 *
 * Two rules this file exists to hold:
 *
 * 1. storeId is in every filter, without exception. Multi-tenancy enforced at the
 *    repository layer means no use case can forget it, because no use case ever
 *    writes a query.
 * 2. Documents are parsed with Zod on the way out, never cast. A document written
 *    by an older version of the code is untrusted input; `as StoreSettings` would
 *    let a missing field travel all the way to a rendered page as `undefined`.
 */

import { LOCALES } from '@platform/locale';
import { type ByRegion, REGIONS, type Region } from '@platform/regions';
import type { Collection, Db } from 'mongodb';
import { z } from 'zod';
import type { StoreSettingsRepository } from '../contracts';
import { createStoreSettings, type StoreSettings } from '../domain/store-settings';

export const STORE_SETTINGS_COLLECTION = 'storeSettings';

const StoreSettingsDocument = z.object({
  storeId: z.string().min(1),
  name: z.string().min(1),
  defaultLocale: z.enum(LOCALES),
  locales: z.array(z.enum(LOCALES)).min(1),
  siteUrl: z.string().min(1),
  contactPhone: z.string().min(1),
  vatBasisPoints: z.number().int(),
  commercialRegistryNumber: z.string().nullable(),
  /*
   * Both shapes, because both exist in the wild.
   *
   * `deliveryFeeCents` is the flat fee this shop charged before delivery was
   * priced per governorate. A document written then still reads: the flat number
   * meant "this much, everywhere", so that is exactly what it becomes. The
   * alternative is a store that stops booting because a field it never had is
   * missing — a migration disguised as a schema.
   */
  deliveryFeeCents: z.number().int().min(0).optional(),
  /*
   * partialRecord, not record: with an enum key Zod's `record` is EXHAUSTIVE and
   * would reject a document that prices seven governorates. Completeness is the
   * domain's job — it fills the gaps here and then refuses what is still missing
   * — and a schema that throws on a half-written table would take the whole shop
   * down rather than the one price.
   */
  deliveryFees: z.partialRecord(z.enum(REGIONS), z.number().int().min(0)).optional(),
});

/**
 * One price per governorate, whichever shape the document is in.
 *
 * A table wins over the legacy flat fee, and a table missing a governorate is
 * filled from the flat fee rather than from zero — an absent price is a price
 * nobody set, and reading it as free would quietly give away every delivery to
 * that governorate.
 */
const feesFrom = (document: {
  deliveryFeeCents?: number | undefined;
  deliveryFees?: Partial<Record<Region, number>> | undefined;
}): ByRegion<number> => {
  const fallback = document.deliveryFeeCents ?? 0;
  const table = document.deliveryFees ?? {};
  return Object.fromEntries(
    REGIONS.map((region) => [region, table[region] ?? fallback]),
  ) as ByRegion<number>;
};

type StoreSettingsDocumentShape = z.infer<typeof StoreSettingsDocument>;

export const createMongoStoreSettingsRepository = (db: Db): StoreSettingsRepository => {
  const collection: Collection<StoreSettingsDocumentShape> =
    db.collection(STORE_SETTINGS_COLLECTION);

  return {
    async findByStoreId(storeId: string): Promise<StoreSettings | null> {
      // storeId is the shard key of this system's data model; the unique index
      // created in ensureStoreIndexes makes this an IXSCAN, which the integration
      // suite asserts on.
      const document = await collection.findOne({ storeId }, { projection: { _id: 0 } });
      if (document === null) return null;

      const parsed = StoreSettingsDocument.safeParse(document);
      if (!parsed.success) {
        throw new Error(
          `storeSettings document for "${storeId}" is malformed: ${parsed.error.message}`,
        );
      }

      const settings = createStoreSettings({ ...parsed.data, deliveryFees: feesFrom(parsed.data) });
      if (!settings.ok) {
        throw new Error(
          `storeSettings document for "${storeId}" violates a domain invariant: ${JSON.stringify(settings.error)}`,
        );
      }
      return settings.value;
    },

    async save(settings: StoreSettings): Promise<void> {
      await collection.updateOne(
        { storeId: settings.storeId },
        {
          $set: {
            ...settings,
            locales: [...settings.locales],
            deliveryFees: { ...settings.deliveryFees },
          },
          // The flat fee is superseded, not merely unused. Leaving it behind
          // would be a second, stale answer to what delivery costs, sitting in
          // the document looking authoritative.
          $unset: { deliveryFeeCents: '' },
        },
        { upsert: true },
      );
    },
  };
};

/** Called once at startup. Idempotent — createIndex is a no-op if it already exists. */
export const ensureStoreIndexes = async (db: Db): Promise<void> => {
  await db
    .collection(STORE_SETTINGS_COLLECTION)
    .createIndex({ storeId: 1 }, { unique: true, name: 'storeId_unique' });
};
