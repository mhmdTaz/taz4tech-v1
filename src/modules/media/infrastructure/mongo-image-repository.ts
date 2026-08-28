/**
 * Mongo adapter for ImageRepository.
 *
 * WHY THE DATABASE AND NOT AN OBJECT STORE
 * ----------------------------------------
 * Because the shop already has one, and this port means it does not have to be
 * the final answer. Atlas is provisioned, paid for, backed up and in the same
 * region as the app; an object store is a second vendor, a second set of
 * credentials and a second thing to be down. For a catalogue of a few thousand
 * product photographs the storage is trivial, and Cloudflare in front of the
 * site caches the bytes anyway — these URLs are immutable, so a CDN can hold
 * them forever without asking.
 *
 * When that stops being true — thousands of products, or egress that shows up on
 * a bill — an R2 adapter implements the same three methods and the composition
 * root changes one line. That is what the port is for, and it is the reason not
 * to buy a vendor before there is a problem to solve.
 *
 * A document per image, not GridFS. Product photographs are far below the 16 MB
 * document cap, and GridFS would add a chunking layer, a second collection and
 * an index to maintain for a case this shop does not have.
 */

import type { Collection, Db } from '@platform/mongo';
import { Binary } from 'mongodb';
import { z } from 'zod';
import type { ImageRepository } from '../contracts';
import { ACCEPTED_TYPES, createStoredImage, type StoredImage } from '../domain/image';

export const MEDIA_COLLECTION = 'media';

const ImageDocument = z.object({
  _id: z.string().length(64),
  storeId: z.string().min(1),
  contentType: z.enum(ACCEPTED_TYPES),
  bytes: z.instanceof(Binary),
  storedAt: z.date(),
});

type ImageDocumentShape = {
  _id: string;
  storeId: string;
  contentType: StoredImage['contentType'];
  bytes: Binary;
  storedAt: Date;
};

export const createMongoImageRepository = (db: Db): ImageRepository => {
  const collection: Collection<ImageDocumentShape> = db.collection(MEDIA_COLLECTION);

  return {
    async findById(storeId, id) {
      const document = await collection.findOne({ _id: id, storeId });
      if (document === null) return null;

      const parsed = ImageDocument.safeParse(document);
      if (!parsed.success) {
        throw new Error(`media document "${id}" is malformed: ${parsed.error.message}`);
      }

      const image = createStoredImage({
        storeId: parsed.data.storeId,
        id: parsed.data._id,
        contentType: parsed.data.contentType,
        bytes: new Uint8Array(parsed.data.bytes.buffer),
        storedAt: parsed.data.storedAt,
      });
      if (!image.ok) {
        throw new Error(`media document "${id}" violates an invariant: ${image.error.tag}`);
      }
      return image.value;
    },

    async exists(storeId, id) {
      /*
       * Projected down to nothing.
       *
       * Re-importing a spreadsheet asks this once per row and the answer is
       * almost always yes. Without the projection each of those answers drags
       * the whole image back out of the database to be thrown away — megabytes
       * per row, to learn one boolean.
       */
      const found = await collection.findOne({ _id: id, storeId }, { projection: { _id: 1 } });
      return found !== null;
    },

    async save(image) {
      /*
       * The id IS the hash of the bytes, so a second write is the same write.
       * `$setOnInsert` rather than `$set` says that out loud: re-storing an
       * image nobody changed does not rewrite megabytes or move its timestamp.
       */
      await collection.updateOne(
        { _id: image.id },
        {
          $setOnInsert: {
            storeId: image.storeId,
            contentType: image.contentType,
            bytes: new Binary(image.bytes),
            storedAt: image.storedAt,
          },
        },
        { upsert: true },
      );
    },
  };
};

/** Called once at startup. Idempotent — createIndex is a no-op if it already exists. */
export const ensureMediaIndexes = async (db: Db): Promise<void> => {
  // _id is already unique and is the only thing looked up by. storeId is in every
  // filter for tenant isolation, so it is indexed alongside it rather than left
  // to be a post-filter on a document that carries megabytes.
  await db
    .collection(MEDIA_COLLECTION)
    .createIndex({ storeId: 1, _id: 1 }, { name: 'store_media' });
};
