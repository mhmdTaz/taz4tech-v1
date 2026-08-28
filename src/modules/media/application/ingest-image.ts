/**
 * Use case: take a supplier's image URL and end up owning the picture.
 *
 * Fetch it once, check it is really an image and really small enough, hash the
 * bytes, store them under that hash, and hand back a path on our own origin.
 *
 * IDEMPOTENT BY CONSTRUCTION
 * --------------------------
 * The id is the SHA-256 of the bytes, so the same picture referenced by forty
 * rows of a spreadsheet is one stored image, and re-importing last month's sheet
 * stores nothing at all. There is no "have I done this already" flag to get out
 * of step with the data — the data is the answer.
 *
 * WHAT IT DOES NOT DO IS FAIL AN IMPORT
 * -------------------------------------
 * Every failure here is reported, never thrown. A supplier CDN that is down for
 * an hour must not stop four hundred products from being imported; the product
 * arrives without that image, the receipt says which rows and why, and importing
 * again later picks up what has come back.
 */

import { err, ok, type Result } from '@platform/result';
import type { FetchFailure, ImageFetcher, ImageRepository } from '../contracts';
import { createStoredImage, type ImageError, imagePath } from '../domain/image';

export type IngestFailure =
  | { readonly tag: 'fetch_failed'; readonly reason: FetchFailure }
  | { readonly tag: 'rejected'; readonly reason: ImageError };

export type IngestOutcome = {
  /** Where the storefront should point: `/media/<sha256>`. */
  readonly path: string;
  /** False when these exact bytes were already here. Reported so an import can say so. */
  readonly stored: boolean;
};

export type IngestImage = (url: string) => Promise<Result<IngestOutcome, IngestFailure>>;

export const makeIngestImage =
  (deps: {
    repository: ImageRepository;
    fetch: ImageFetcher;
    sha256Hex: (bytes: Uint8Array) => string;
    storeId: string;
    now: () => Date;
  }): IngestImage =>
  async (url) => {
    const fetched = await deps.fetch(url);
    if (!fetched.ok) return err({ tag: 'fetch_failed', reason: fetched.error });

    const id = deps.sha256Hex(fetched.value.bytes);

    /*
     * Asked before the domain is consulted, and that order is deliberate: bytes
     * already stored were validated when they were stored, so re-checking them
     * would be work done on every row of every re-import to reach a conclusion
     * the database already holds.
     */
    if (await deps.repository.exists(deps.storeId, id)) {
      return ok({ path: imagePath(id), stored: false });
    }

    const image = createStoredImage({
      storeId: deps.storeId,
      id,
      contentType: fetched.value.contentType,
      bytes: fetched.value.bytes,
      storedAt: deps.now(),
    });
    if (!image.ok) return err({ tag: 'rejected', reason: image.error });

    await deps.repository.save(image.value);
    return ok({ path: imagePath(id), stored: true });
  };

/**
 * A one-line reason, for an import receipt.
 *
 * The row number and the URL are the caller's to add; this says what went wrong
 * in words somebody looking at a spreadsheet can act on.
 */
export const describeIngestFailure = (failure: IngestFailure): string => {
  if (failure.tag === 'fetch_failed') {
    if (failure.reason.tag === 'not_ok') return `the server answered ${failure.reason.status}`;
    if (failure.reason.tag === 'too_large') return 'the file is larger than 5 MB';
    return `the image could not be fetched (${failure.reason.reason})`;
  }

  const reason = failure.reason;
  if (reason.tag === 'unsupported_type') return `${reason.contentType} is not an image we can show`;
  if (reason.tag === 'too_large') return 'the file is larger than 5 MB';
  if (reason.tag === 'empty') return 'the server sent an empty file';
  return 'the image could not be stored';
};
