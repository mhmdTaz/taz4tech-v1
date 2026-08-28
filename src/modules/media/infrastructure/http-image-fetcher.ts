/**
 * Fetching somebody else's image.
 *
 * This is the one place in the shop that makes an outbound request to a URL
 * written by whoever produced a spreadsheet, so it is written defensively rather
 * than optimistically.
 *
 *   - Only http and https. A `file://` in a supplier sheet would otherwise ask
 *     the server to read its own disk and store the result.
 *   - A timeout, because a supplier host that accepts a connection and then says
 *     nothing would otherwise hold an import open until somebody notices.
 *   - Redirects followed by fetch itself, but the scheme is re-checked on the
 *     URL that answered — a redirect from https to file is a redirect worth
 *     refusing.
 *   - The size checked from the header when there is one AND from the bytes
 *     when there is not, because Content-Length is a claim, not a measurement.
 *
 * What it deliberately does NOT do is block private address ranges. This runs on
 * a host with no private network worth reaching, the URLs come from an
 * authenticated operator's own spreadsheet rather than from the public, and a
 * half-built SSRF filter that misses IPv6-mapped addresses would be worse than
 * an honest note saying there is not one. If this ever accepts URLs from
 * customers, that changes.
 */

import { err, ok, type Result } from '@platform/result';
import type { FetchedImage, FetchFailure, ImageFetcher } from '../contracts';
import { MAX_BYTES } from '../domain/image';

const TIMEOUT_MS = 10_000;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** `image/jpeg; charset=binary` is a JPEG. */
const bareType = (header: string | null): string =>
  (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

export const createHttpImageFetcher = (options: { timeoutMs?: number } = {}): ImageFetcher => {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  return async (url: string): Promise<Result<FetchedImage, FetchFailure>> => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return err({ tag: 'unreachable', reason: 'not a URL' });
    }

    if (!ALLOWED_PROTOCOLS.has(target.protocol)) {
      return err({ tag: 'unreachable', reason: `${target.protocol} is not fetched` });
    }

    try {
      const response = await fetch(target, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
        headers: { accept: 'image/*' },
      });

      if (!response.ok) return err({ tag: 'not_ok', status: response.status });

      // Re-checked on the URL that actually answered: a redirect can change the
      // scheme, and the check above only saw where we started.
      if (!ALLOWED_PROTOCOLS.has(new URL(response.url).protocol)) {
        return err({ tag: 'unreachable', reason: 'redirected to a scheme we do not fetch' });
      }

      /*
       * Refused from the header before a byte is read, when the header is there.
       * Reading 200 MB in order to discover it is 200 MB is a denial of service
       * a supplier can perform by accident.
       */
      const declared = Number(response.headers.get('content-length') ?? Number.NaN);
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        return err({ tag: 'too_large', byteLength: declared });
      }

      const bytes = new Uint8Array(await response.arrayBuffer());

      // And again from what actually arrived, because Content-Length is a claim.
      if (bytes.byteLength > MAX_BYTES) {
        return err({ tag: 'too_large', byteLength: bytes.byteLength });
      }

      return ok({ bytes, contentType: bareType(response.headers.get('content-type')) });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.name : 'failed';
      return err({ tag: 'unreachable', reason });
    }
  };
};
