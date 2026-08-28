/**
 * Bring a store into existence.
 *
 *   pnpm seed             creates the settings document if there is none, and
 *                         otherwise leaves it exactly as it is
 *   pnpm seed --reset     overwrites it with the defaults below
 *
 * THE DEFAULT IS CREATE-ONLY, AND THAT IS THE POINT
 * -------------------------------------------------
 * The shop's name, its phone number, the VAT rate and the eight delivery prices
 * are edited by an operator in the admin. A seeder that rewrote them from
 * constants in this file would turn "run the seed again" — something anyone
 * would do to a database that looks empty, or that a deploy runbook might do on
 * every release — into "undo everything anyone configured", silently and with a
 * cheerful success message.
 *
 * So the values below are what a store STARTS with, not what it is kept at.
 * Delivery is free everywhere until somebody prices it, because a made-up price
 * is charged to a real customer at their door.
 *
 * `--reset` exists for test databases, which have to be put back to a known
 * state — and it refuses any database that is not on this machine unless the
 * database is named in TAZ_SEED_TARGET. Discarding a shop's name, phone number,
 * VAT rate and eight delivery prices is not something a mistyped command should
 * be able to do quietly. See guard-remote.ts.
 *
 * Note it goes through the module barrel and the composition root, exactly like
 * the app does. A seeder that talks to the collection directly is a seeder that
 * can write a document the domain would have rejected.
 */

import { sameEverywhere } from '@platform/regions';
import { getContainer } from '../src/composition/index.js';
import { deliverySpread, type StoreSettings } from '../src/modules/store/index.js';
import { getConfig } from '../src/platform/config/index.js';
import { closeMongo } from '../src/platform/mongo/index.js';
import { remoteRefusal } from './guard-remote.js';

const RESET_FLAG = '--reset';

const rejected = (error: unknown): void => {
  console.error('Seed rejected by the domain:', JSON.stringify(error, null, 2));
  process.exitCode = 1;
};

/**
 * Say out loud that an unpriced shop is a shop advertising free delivery.
 *
 * Zero is a legitimate price and the storefront renders it honestly: /delivery
 * prints "Free" in green against all eight governorates and the checkout quotes
 * a total with nothing added. What it cannot know is whether somebody DECIDED
 * that or simply has not typed the numbers yet — and the default here is zero,
 * so a fresh deploy makes a public price commitment that nobody made.
 *
 * Fees are never negative, so a maximum of zero means the whole table is.
 */
const warnIfUnpriced = (settings: StoreSettings): void => {
  if (deliverySpread(settings).max !== 0) return;

  console.warn(
    '\nDelivery is $0.00 to every governorate.\n' +
      'The storefront is telling customers delivery is FREE, everywhere, right now.\n' +
      'If that is not the intention, price it at /admin/settings before anyone orders.',
  );
};

const main = async (): Promise<void> => {
  const reset = process.argv.slice(2).includes(RESET_FLAG);

  /*
   * Before the connection, not after.
   *
   * Refusing after `getContainer()` would still refuse the write, but it would
   * connect to the production cluster and create indexes on it first — and when
   * the host is unreachable it buries the guard's message under a DNS error.
   */
  const config = getConfig();
  const database = config.mongo.database;

  if (reset) {
    const refusal = remoteRefusal({
      uri: config.mongo.uri,
      database,
      action: 'replace the store settings',
      command: `pnpm seed ${RESET_FLAG}`,
    });

    if (refusal !== null) {
      console.error(refusal);
      console.error('');
      console.error('Without --reset this script leaves an existing store alone.');
      process.exitCode = 1;
      return;
    }
  }

  const container = await getContainer();
  await container.store.ensureIndexes();

  const defaults: StoreSettings = {
    storeId: config.storeId,
    name: 'Taz4Tech',
    contactPhone: '+96170000000',
    // Lebanon's VAT rate is 11%. Whether this store must charge it depends on
    // registration, which is not settled — see the note on the domain type.
    vatBasisPoints: 1100,
    // Law 81/2018 Art. 31. Null until the business is registered; the storefront
    // hides the line rather than printing an empty label.
    commercialRegistryNumber: null,
    // Free to every governorate to start. Real prices are set in the admin, from
    // deliveries that have actually happened — and once set, this script leaves
    // them alone.
    deliveryFees: sameEverywhere(0),
  };

  if (reset) {
    console.warn(`Overwriting store settings in database "${database}".`);

    const result = await container.store.saveStoreSettings(defaults);
    if (!result.ok) return rejected(result.error);

    console.warn(`Reset store "${result.value.storeId}" in database "${database}".`);
    warnIfUnpriced(result.value);
    return;
  }

  const result = await container.store.ensureStoreSettings(defaults);
  if (!result.ok) return rejected(result.error);

  if (result.value.tag === 'created') {
    console.warn(`Created store "${result.value.settings.storeId}" in database "${database}".`);
    warnIfUnpriced(result.value.settings);
    return;
  }

  console.warn(
    `Store "${result.value.settings.storeId}" already has settings in database "${database}" — left untouched.\n` +
      `Edit them at /admin/settings. To replace them from this script: pnpm seed ${RESET_FLAG}`,
  );
  // The stored ones, not the defaults — a shop that has been live for a month
  // and still has not priced delivery is exactly who needs telling.
  warnIfUnpriced(result.value.settings);
};

main()
  .catch((error: unknown) => {
    // A malformed or invariant-violating document makes the READ throw, and
    // leaving it alone cannot repair that. Say which flag can.
    console.error('Seed failed:', error);
    console.error(`If the stored settings are broken, "pnpm seed ${RESET_FLAG}" replaces them.`);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
