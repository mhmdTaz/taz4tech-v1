/**
 * Public surface of the media module.
 *
 * The shop's own copy of every catalogue picture. Nothing above this line knows
 * whether that copy lives in Mongo, in an object store, or anywhere else — which
 * is the point, because it lives in Mongo today and probably will not forever.
 */

import { createHash } from 'node:crypto';
import type { Db } from '@platform/mongo';
import { type IngestImage, makeIngestImage } from './application/ingest-image';
import { createHttpImageFetcher } from './infrastructure/http-image-fetcher';
import {
  createMongoImageRepository,
  ensureMediaIndexes,
} from './infrastructure/mongo-image-repository';
import { createR2ImageRepository, type R2Config } from './infrastructure/r2-image-repository';

export type { IngestFailure, IngestImage, IngestOutcome } from './application/ingest-image';
export { describeIngestFailure } from './application/ingest-image';
export type { FetchedImage, FetchFailure, ImageFetcher, ImageRepository } from './contracts';
export type { ImageError, ImageType, StoredImage } from './domain/image';
export {
  ACCEPTED_TYPES,
  CACHE_CONTROL,
  createStoredImage,
  imagePath,
  isImageType,
  MAX_BYTES,
} from './domain/image';

export type MediaModule = {
  readonly ingestImage: IngestImage;
  /** Bytes for the route that serves them. Null when nothing is stored under that id. */
  readonly findImage: (id: string) => Promise<import('./domain/image').StoredImage | null>;
  readonly ensureIndexes: () => Promise<void>;
};

export const createMediaModule = (deps: {
  db: Db;
  storeId: string;
  now: () => Date;
  /**
   * Where the bytes live. Absent means MongoDB, which is the default and was
   * the only option until there was a reason for a second one.
   *
   * This is the line the Mongo adapter's comment promised: an object store
   * arrives as four environment variables, and nothing above this file — not
   * the use case, not the route that serves an image, not the importer — knows
   * which one answered.
   */
  r2?: R2Config | null;
}): MediaModule => {
  const repository =
    deps.r2 == null ? createMongoImageRepository(deps.db) : createR2ImageRepository(deps.r2);

  return {
    ingestImage: makeIngestImage({
      repository,
      fetch: createHttpImageFetcher(),
      // Node's, not WebCrypto's: this one is synchronous, and hashing a few
      // megabytes already in memory has nothing to await.
      sha256Hex: (bytes) => createHash('sha256').update(bytes).digest('hex'),
      storeId: deps.storeId,
      now: deps.now,
    }),
    findImage: (id) => repository.findById(deps.storeId, id),
    ensureIndexes: () => ensureMediaIndexes(deps.db),
  };
};
