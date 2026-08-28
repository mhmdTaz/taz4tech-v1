/**
 * An image the shop owns a copy of.
 *
 * WHY THE SHOP KEEPS ITS OWN COPY
 * -------------------------------
 * The catalogue importer takes an image URL straight out of a supplier's
 * spreadsheet, so until now every picture on the storefront was served by
 * somebody else's machine. That is two problems wearing one coat. The day a
 * supplier tidies up their CDN, products go blank — and `next/image` cannot
 * optimise a host it does not trust, so listing every supplier domain in
 * `remotePatterns` would turn the optimiser into an image proxy for anything
 * that can be named in a spreadsheet.
 *
 * Fetching once and storing the bytes solves both: one origin, under our
 * control, that cannot disappear because a supplier reorganised a folder.
 *
 * Framework-free and IO-free, like every domain file here. The fetching and the
 * storing happen a layer up; this decides only what is allowed to be stored.
 */

import { err, ok, type Result } from '@platform/result';

/**
 * The formats a browser can show and Next can optimise.
 *
 * SVG IS DELIBERATELY ABSENT. An SVG is a document, not a picture: it can carry
 * script and external references, and serving one from our own origin would run
 * a supplier's markup inside the shop's security context. Every raster format
 * below is inert by comparison. The two SVGs already in `public/` are ours and
 * are not ingested through here.
 *
 * AVIF is absent for a duller reason: Next 16.3.3 disables its AVIF decoder to
 * patch an RCE, so an AVIF we accepted would be one the optimiser refuses.
 */
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

export type ImageType = (typeof ACCEPTED_TYPES)[number];

/**
 * Five megabytes.
 *
 * Comfortably above a real product photograph and well below anything that
 * would hurt to hold in memory while it is hashed. A supplier sheet pointing at
 * a 200 MB TIFF is a mistake, not a picture.
 */
export const MAX_BYTES = 5 * 1024 * 1024;

export type StoredImage = {
  readonly storeId: string;
  /**
   * The SHA-256 of the bytes, hex.
   *
   * Content-addressed on purpose: the same picture referenced by forty rows of
   * a spreadsheet is fetched once and stored once, and re-importing a sheet
   * costs nothing because every id is already there. It also means the URL can
   * be cached forever — bytes that change are a different id.
   */
  readonly id: string;
  readonly contentType: ImageType;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly storedAt: Date;
};

export type ImageError =
  | { readonly tag: 'empty' }
  | { readonly tag: 'too_large'; readonly byteLength: number; readonly max: number }
  | { readonly tag: 'unsupported_type'; readonly contentType: string }
  | { readonly tag: 'id_invalid'; readonly id: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const isImageType = (value: string): value is ImageType =>
  (ACCEPTED_TYPES as readonly string[]).includes(value);

/**
 * The only way to obtain a StoredImage, so anything of this type is safe to
 * serve: the bytes exist, they are within the cap, and the content type is one
 * a browser will render rather than execute.
 */
export const createStoredImage = (input: {
  readonly storeId: string;
  readonly id: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly storedAt: Date;
}): Result<StoredImage, ImageError> => {
  if (!SHA256_HEX.test(input.id)) return err({ tag: 'id_invalid', id: input.id });
  if (input.bytes.byteLength === 0) return err({ tag: 'empty' });

  // Type before size. A row pointing at a PDF is answered with "that is not an
  // image" whether the file is 2 KB or 200 MB, and that is the sentence which
  // tells whoever wrote the spreadsheet what to change.
  if (!isImageType(input.contentType)) {
    return err({ tag: 'unsupported_type', contentType: input.contentType });
  }

  if (input.bytes.byteLength > MAX_BYTES) {
    return err({ tag: 'too_large', byteLength: input.bytes.byteLength, max: MAX_BYTES });
  }

  return ok({
    storeId: input.storeId,
    id: input.id,
    contentType: input.contentType,
    bytes: input.bytes,
    byteLength: input.bytes.byteLength,
    storedAt: input.storedAt,
  });
};

/** Where the storefront asks for it. Same origin, so `next/image` needs no allowlist. */
export const imagePath = (id: string): string => `/media/${id}`;

/**
 * Content-addressed, so the bytes behind a URL can never change.
 *
 * A year, immutable. The only way to get different bytes is a different id, so
 * there is no cache to bust and no revalidation to pay for.
 */
export const CACHE_CONTROL = 'public, max-age=31536000, immutable';
