/**
 * Ports. The application layer depends on these; infrastructure implements them.
 */

import type { Result } from '@platform/result';
import type { StoredImage } from '../domain/image';

export interface ImageRepository {
  /** Bytes and content type for one id, or null. Used by the route that serves them. */
  findById(storeId: string, id: string): Promise<StoredImage | null>;
  /**
   * Whether these bytes are already here.
   *
   * Cheaper than a full read: re-importing a spreadsheet asks this once per row
   * and the answer is almost always yes, so it must not drag megabytes back out
   * of the database to say so.
   */
  exists(storeId: string, id: string): Promise<boolean>;
  /** Idempotent by construction — the id IS the bytes, so a second write is the same write. */
  save(image: StoredImage): Promise<void>;
}

export type FetchFailure =
  | { readonly tag: 'unreachable'; readonly reason: string }
  | { readonly tag: 'not_ok'; readonly status: number }
  /** The response claimed a size past the cap before a single byte was read. */
  | { readonly tag: 'too_large'; readonly byteLength: number };

export type FetchedImage = {
  readonly bytes: Uint8Array;
  /** As the server declared it, lowercased and stripped of any `; charset=`. */
  readonly contentType: string;
};

/**
 * Reading somebody else's URL.
 *
 * A port rather than a bare `fetch` so the use case can be tested without a
 * network — which matters more here than usual, because the interesting cases
 * are all the ways a supplier's server misbehaves.
 */
export type ImageFetcher = (url: string) => Promise<Result<FetchedImage, FetchFailure>>;
