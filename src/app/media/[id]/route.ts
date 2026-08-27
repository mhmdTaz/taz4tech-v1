import { CACHE_CONTROL } from '@modules/media';
import { getContainer } from '@/composition';

/**
 * Serving the shop's own copy of a catalogue image.
 *
 * Outside `[locale]` on purpose: a picture is the same picture in Arabic, and
 * three URLs for one set of bytes would split every cache three ways for nothing.
 *
 * The response is immutable for a year, which is safe rather than optimistic:
 * the id is the SHA-256 of the bytes, so bytes that change are a different URL.
 * There is nothing to invalidate and no revalidation to pay for.
 */

/** Reads the database. Nothing here can be prerendered — see scripts/build-like-ci.mjs. */
export const dynamic = 'force-dynamic';

/** A SHA-256 in hex, and nothing else. */
const ID = /^[0-9a-f]{64}$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  /*
   * Checked before the database is asked.
   *
   * The id goes straight into a filter, so refusing anything that is not a hash
   * keeps arbitrary strings out of the query entirely — and it turns a scan for
   * `/media/../../etc/passwd` into a 404 without a round trip.
   */
  if (!ID.test(id)) return new Response('Not found', { status: 404 });

  const container = await getContainer();
  const image = await container.media.findImage(id);

  if (image === null) return new Response('Not found', { status: 404 });

  return new Response(new Uint8Array(image.bytes), {
    headers: {
      'Content-Type': image.contentType,
      'Content-Length': String(image.byteLength),
      'Cache-Control': CACHE_CONTROL,
      // The content type is ours, from a closed list, and the bytes are raster
      // images — but a browser that sniffs its way to something else is a browser
      // executing a supplier's file on our origin.
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
