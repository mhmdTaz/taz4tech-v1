/**
 * Seed the store's settings document.
 *
 * Idempotent: safe to run against a database that already has one. Used by CI
 * before the e2e and Lighthouse jobs, and once by hand against Atlas.
 *
 *   pnpm seed
 *
 * Note it goes through the module barrel and the composition root, exactly like
 * the app does. A seeder that talks to the collection directly is a seeder that
 * can write a document the domain would have rejected.
 */

import { getContainer } from '../src/composition/index.js';
import { closeMongo } from '../src/platform/mongo/index.js';

const main = async (): Promise<void> => {
  const container = await getContainer();

  await container.store.ensureIndexes();

  const result = await container.store.saveStoreSettings({
    storeId: container.config.storeId,
    name: 'Taz4Tech',
    defaultLocale: 'en',
    locales: ['en', 'ar', 'fr'],
    siteUrl: container.config.siteUrl,
    contactPhone: '+96170000000',
    // Lebanon's VAT rate is 11%. Whether this store must charge it depends on
    // registration, which is not settled — see the note on the domain type.
    vatBasisPoints: 1100,
    // Law 81/2018 Art. 31. Null until the business is registered; the storefront
    // hides the line rather than printing an empty label.
    commercialRegistryNumber: null,
    // Flat and free to start. The region is recorded on every order, so a
    // per-governorate table can be priced from real deliveries later.
    deliveryFeeCents: 0,
  });

  if (!result.ok) {
    console.error('Seed rejected by the domain:', JSON.stringify(result.error, null, 2));
    process.exitCode = 1;
    return;
  }

  console.warn(
    `Seeded store "${result.value.storeId}" in database "${container.config.mongo.database}".`,
  );
};

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
