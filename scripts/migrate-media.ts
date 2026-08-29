/**
 * Copy product photographs from MongoDB into R2.
 *
 *   pnpm media:migrate            lists what would be copied
 *   pnpm media:migrate --commit   copies it
 *
 * WHY THIS EXISTS
 * ---------------
 * Setting the four R2 variables changes where images are READ from as well as
 * written to. Every photograph already in Mongo would become a 404 the moment
 * the deploy went out — product pages with holes in them, on a shop that sells
 * things people want to look at first.
 *
 * So the order is: run this against production with the R2 variables set in the
 * shell, confirm the count, then deploy with them set on the service. Between
 * those two the bucket has everything and the app is still reading from Mongo,
 * which is a state where nothing is broken.
 *
 * SAFE TO RUN TWICE
 * -----------------
 * An image id IS the SHA-256 of its bytes, so a copy is content-addressed:
 * anything already in the bucket is skipped, and a second run copies only what
 * a first one missed. There is no partial state to clean up if it stops
 * halfway.
 *
 * NOTHING IS DELETED FROM MONGO. Ever, by this script. Keeping both copies
 * costs a few megabytes and is the difference between a reversible migration
 * and a one-way door.
 */

import { createMongoImageRepository } from '../src/modules/media/infrastructure/mongo-image-repository.js';
import { createR2ImageRepository } from '../src/modules/media/infrastructure/r2-image-repository.js';
import { getConfig } from '../src/platform/config/index.js';
import { closeMongo, getDb } from '../src/platform/mongo/index.js';

const COMMIT_FLAG = '--commit';

/*
 * The ids are read straight off the collection rather than through the port.
 *
 * ImageRepository has three methods and none of them is "list": the storefront
 * looks images up by id and never enumerates them. Widening a port permanently
 * to serve one migration is the wrong trade — so the enumeration is local to
 * this file, and every byte that moves still goes through the port on both
 * sides, which is what applies the domain's rules to what gets written.
 */
const MEDIA_COLLECTION = 'media';

const main = async (): Promise<void> => {
  const commit = process.argv.slice(2).includes(COMMIT_FLAG);
  const config = getConfig();

  if (config.r2 === null) {
    console.error('R2 is not configured, so there is nowhere to copy to.');
    console.error(
      'Set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY and run again.',
    );
    process.exitCode = 1;
    return;
  }

  /*
   * Both adapters, built by name, rather than whichever one the container
   * chose.
   *
   * The container is already pointing at R2 by the time this runs — that is
   * what the four variables being set means — so reading through it would ask
   * the destination for images the source is holding, find nothing to do, and
   * report success. A migration that reads from the place it is writing to is
   * the one shape of this script that cannot work.
   */
  const db = await getDb({ uri: config.mongo.uri, database: config.mongo.database });
  const source = createMongoImageRepository(db);
  const target = createR2ImageRepository(config.r2);

  const stored = await db
    .collection<{ _id: string; storeId: string }>(MEDIA_COLLECTION)
    .find({ storeId: config.storeId }, { projection: { _id: 1, storeId: 1 } })
    .toArray();

  console.warn(
    `${stored.length} image(s) in database "${config.mongo.database}" for store "${config.storeId}".`,
  );

  let copied = 0;
  let already = 0;
  let missing = 0;

  for (const { _id: id } of stored) {
    if (await target.exists(config.storeId, id)) {
      already += 1;
      continue;
    }

    if (!commit) {
      console.warn(`  would copy ${id}`);
      copied += 1;
      continue;
    }

    // Through the Mongo repository, so a document the domain would refuse is
    // refused here rather than copied into a second store and forgotten.
    const image = await source.findById(config.storeId, id);
    if (image === null) {
      // Listed a moment ago and unreadable now: worth naming rather than
      // counting silently, because it means the row and the bytes disagree.
      console.error(`  MISSING ${id} — listed but could not be read`);
      missing += 1;
      continue;
    }

    await target.save(image);
    console.warn(`  copied ${id}`);
    copied += 1;
  }

  console.warn(
    `\n${copied} ${commit ? 'copied' : 'to copy'}, ${already} already there` +
      (missing > 0 ? `, ${missing} unreadable` : ''),
  );

  if (!commit && copied > 0) {
    console.warn(`\n  DRY RUN — nothing was written. Re-run with ${COMMIT_FLAG} to apply.\n`);
  }

  if (missing > 0) process.exitCode = 1;
};

main()
  .catch((error: unknown) => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  })
  .finally(closeMongo);
