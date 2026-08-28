/**
 * Set one delivery price for every governorate.
 *
 *   pnpm delivery:price 4.00          all eight at $4.00
 *   pnpm delivery:price 4.00 --force  ...even if they currently differ
 *
 * WHY THIS EXISTS AND WHY IT IS SMALL
 * -----------------------------------
 * Delivery prices belong to the operator and are edited at /admin/settings.
 * This is for the one moment that screen cannot cover: a shop that has just been
 * seeded, where every governorate is $0.00 and the storefront is therefore
 * advertising free delivery to all of Lebanon until somebody types eight
 * numbers. Setting them once, from a command, is faster than a form — and once
 * is all this is for.
 *
 * So it takes ONE amount and applies it to all eight. Anything shaped like a
 * real pricing decision — Beirut cheaper than Akkar, a governorate revised after
 * a month of actual deliveries — is a decision with a person behind it, and that
 * person has a screen.
 *
 * IT REFUSES TO FLATTEN A PRICED TABLE
 * ------------------------------------
 * If the eight fees already differ from each other, somebody has priced them,
 * and setting one number everywhere would discard that with no way back and no
 * error. That needs --force, and --force prints what it is about to destroy.
 *
 * WHAT IT DOES NOT TOUCH
 * ----------------------
 * The shop's name, phone number, VAT rate and registry number are read back and
 * written unchanged, through `toForm`. It goes through updateStoreSettings —
 * the same use case the admin form posts to — so "4.00" is parsed by the same
 * parser, validated by the same domain, and a bad value is refused here for the
 * same reason it would be refused there. A second implementation of "what is a
 * price" is how a script and a screen come to disagree.
 */

import { REGIONS, sameEverywhere } from '@platform/regions';
import { getContainer } from '../src/composition/index.js';
import { deliverySpread, toForm } from '../src/modules/store/index.js';
import { getConfig } from '../src/platform/config/index.js';
import { closeMongo } from '../src/platform/mongo/index.js';
import { remoteRefusal } from './guard-remote.js';

const FORCE_FLAG = '--force';

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

const table = (fees: Record<string, number>): string =>
  REGIONS.map((region) => `  ${region.padEnd(16)}${usd(fees[region] ?? 0)}`).join('\n');

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const force = args.includes(FORCE_FLAG);
  const amount = args.find((arg) => arg !== FORCE_FLAG);

  if (amount === undefined) {
    console.error('Usage: pnpm delivery:price <amount>   e.g. pnpm delivery:price 4.00');
    process.exitCode = 1;
    return;
  }

  // Before the connection, so an unreachable host cannot bury the refusal under
  // a DNS error — and so a production cluster is never even dialled.
  const config = getConfig();
  const database = config.mongo.database;

  const refusal = remoteRefusal({
    uri: config.mongo.uri,
    database,
    action: 'change the delivery prices',
    command: `pnpm delivery:price ${args.join(' ')}`,
  });

  if (refusal !== null) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }

  const container = await getContainer();

  const current = await container.store.getStoreSettings();
  if (!current.ok) {
    console.error('No store settings to change:', JSON.stringify(current.error, null, 2));
    console.error('Create the store first: pnpm seed');
    process.exitCode = 1;
    return;
  }

  const before = current.value.deliveryFees;
  const spread = deliverySpread(current.value);

  if (spread.min !== spread.max && !force) {
    console.error('Refusing: these governorates are already priced differently.\n');
    console.error(table(before));
    console.error(
      `\nOne number would replace all eight. Edit them at /admin/settings, or if` +
        `\nflattening them really is the intention:\n\n  pnpm delivery:price ${amount} ${FORCE_FLAG}`,
    );
    process.exitCode = 1;
    return;
  }

  // The whole form, with only the fees replaced: everything else is written back
  // exactly as it was read.
  const updated = await container.store.updateStoreSettings({
    ...toForm(current.value),
    deliveryFees: sameEverywhere(amount),
  });

  if (!updated.ok) {
    console.error('Refused:', JSON.stringify(updated.error, null, 2));
    process.exitCode = 1;
    return;
  }

  console.warn(`Database "${database}", store "${updated.value.storeId}".\n`);
  console.warn('before');
  console.warn(table(before));
  console.warn('\nafter');
  console.warn(table(updated.value.deliveryFees));
  console.warn('\nEdit them from now on at /admin/settings.');
};

main()
  .catch((error: unknown) => {
    console.error('Could not set the delivery prices:', error);
    process.exitCode = 1;
  })
  .finally(closeMongo);
