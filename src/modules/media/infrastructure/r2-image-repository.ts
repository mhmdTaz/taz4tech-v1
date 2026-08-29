/**
 * Cloudflare R2 adapter for ImageRepository.
 *
 * The same three methods as the Mongo one, which is the whole point of the
 * port: the composition root picks one and nothing else in the system knows
 * which. See mongo-image-repository.ts for why the database was the right first
 * answer, and what changes when it stops being.
 *
 * WHY R2 AND NOT S3 PROPER
 * ------------------------
 * Cloudflare is already in front of this site, and R2 charges nothing for
 * egress — which is the entire bill for a product catalogue, where every byte
 * is read far more often than it is written. It speaks S3's API, so this is an
 * S3 adapter that happens to point at Cloudflare.
 *
 * THE KEY IS THE TENANT AND THE HASH
 * ----------------------------------
 * `<storeId>/<sha256>`. Tenant isolation is in the key rather than in a filter,
 * so a bug cannot return another store's image: a wrong storeId asks for an
 * object that does not exist. The id is the hash of the bytes, so a second
 * write of the same image is the same object, and the URL can be cached
 * forever.
 */

import { encodePath, hashPayload, signRequest } from '@platform/s3';
import type { ImageRepository } from '../contracts';
import { createStoredImage, isImageType } from '../domain/image';

export type R2Config = {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

/** R2 has one region and calls it this. */
const REGION = 'auto';
const SERVICE = 's3';

export const createR2ImageRepository = (
  config: R2Config,
  now: () => Date = () => new Date(),
): ImageRepository => {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;

  const send = async (
    method: 'GET' | 'HEAD' | 'PUT',
    key: string,
    body?: { readonly bytes: Uint8Array; readonly contentType: string },
  ): Promise<Response> => {
    const path = encodePath(`/${config.bucket}/${key}`);
    const payload = body?.bytes ?? new Uint8Array();
    const payloadHash = await hashPayload(payload);

    const headers = await signRequest({
      method,
      path,
      host,
      region: REGION,
      service: SERVICE,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      payloadHash,
      // S3 requires the payload hash as a header as well as in the signature.
      headers:
        body === undefined
          ? { 'x-amz-content-sha256': payloadHash }
          : { 'x-amz-content-sha256': payloadHash, 'content-type': body.contentType },
      now: now(),
    });

    return fetch(`https://${host}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: body.bytes as BodyInit }),
    });
  };

  const keyFor = (storeId: string, id: string) => `${storeId}/${id}`;

  return {
    async findById(storeId, id) {
      const response = await send('GET', keyFor(storeId, id));
      if (response.status === 404) return null;
      if (!response.ok) {
        // Anything else is a fault, not an absence. Returning null would turn a
        // broken bucket into a catalogue that has quietly lost its photographs.
        throw new Error(`R2 refused GET ${id}: ${response.status} ${await response.text()}`);
      }

      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!isImageType(contentType)) {
        throw new Error(`R2 object "${id}" is not an image this shop stores: "${contentType}"`);
      }

      const lastModified = response.headers.get('last-modified');
      const image = createStoredImage({
        storeId,
        id,
        contentType,
        bytes: new Uint8Array(await response.arrayBuffer()),
        // Second resolution, which is all Last-Modified carries. Nothing reads
        // this to order or expire anything — the URL is immutable — so the
        // header is preferred to inventing a fresher timestamp on every read.
        storedAt: lastModified === null ? now() : new Date(lastModified),
      });

      if (!image.ok) {
        throw new Error(`R2 object "${id}" violates an invariant: ${image.error.tag}`);
      }
      return image.value;
    },

    async exists(storeId, id) {
      // HEAD, so re-importing a spreadsheet does not pull megabytes back across
      // the network once per row to learn one boolean.
      const response = await send('HEAD', keyFor(storeId, id));
      if (response.status === 404) return false;
      if (!response.ok) {
        throw new Error(`R2 refused HEAD ${id}: ${response.status}`);
      }
      return true;
    },

    async save(image) {
      /*
       * A plain PUT, not a conditional one.
       *
       * The Mongo adapter uses $setOnInsert so a re-store does not rewrite
       * megabytes or move a timestamp. The equivalent here would be
       * `If-None-Match: *`, and it is deliberately not used: this adapter cannot
       * be tested against a real bucket from CI, so it sticks to the parts of
       * the S3 API that every implementation has had for a decade. Rewriting an
       * object with byte-identical content is wasteful, not wrong — the id is
       * the hash, so there is no version of this that stores something else.
       */
      const response = await send('PUT', keyFor(image.storeId, image.id), {
        bytes: image.bytes,
        contentType: image.contentType,
      });

      if (!response.ok) {
        throw new Error(`R2 refused PUT ${image.id}: ${response.status} ${await response.text()}`);
      }
    },
  };
};
