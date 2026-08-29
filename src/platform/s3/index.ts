/**
 * Signing requests for an S3-compatible object store.
 *
 * WHY NOT THE AWS SDK
 * -------------------
 * Three operations are needed — GET, HEAD, PUT of one object — and
 * `@aws-sdk/client-s3` brings several dozen packages to provide them. This
 * project has seven runtime dependencies and `pnpm audit --prod` gates every
 * PR; the S3 client would roughly double the surface that audit covers, to sign
 * three requests.
 *
 * The thing being avoided is not the code, it is the maintenance. SigV4 is a
 * fixed, published algorithm that has not changed since 2012: HMAC-SHA256 four
 * times over a canonical string. It is written here the same way the admin
 * session signer is, on WebCrypto, and tested against Amazon's own published
 * vectors rather than against itself.
 *
 * A SIGNING BUG FAILS CLOSED
 * --------------------------
 * Which is the reason this is a reasonable thing to hand-write at all. A wrong
 * signature is a 403 from the store — loud, immediate, and caught by the first
 * request. It cannot silently authorise anything: the secret never leaves this
 * process, and the signature is only ever checked by the far end.
 */

const utf8 = new TextEncoder();

const HEX = '0123456789abcdef';

const toHex = (bytes: Uint8Array): string => {
  let out = '';
  // Indexed with `?? ''` because noUncheckedIndexedAccess types a lookup as
  // possibly undefined; a nibble is 0..15 and HEX has sixteen characters, so
  // the fallback is unreachable rather than a real case.
  for (const byte of bytes) out += (HEX[byte >> 4] ?? '') + (HEX[byte & 15] ?? '');
  return out;
};

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));

const hmac = async (key: Uint8Array, message: string): Promise<Uint8Array> => {
  const imported = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, utf8.encode(message)));
};

/** SHA-256 of a payload, hex-encoded. Empty bodies included — S3 wants the hash of nothing. */
export const hashPayload = async (body: Uint8Array): Promise<string> => toHex(await sha256(body));

/**
 * Percent-encoding for a URI path, to S3's rules.
 *
 * `encodeURIComponent` is close but leaves `!'()*` alone, and S3 signs them
 * encoded. A path that disagrees with the signature by one character is a 403
 * with no explanation, so it is spelled out rather than assumed.
 */
export const encodePath = (path: string): string =>
  path
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');

export type SignedRequest = {
  readonly method: 'GET' | 'HEAD' | 'PUT';
  /** Already percent-encoded, starting with a slash. */
  readonly path: string;
  readonly host: string;
  readonly region: string;
  readonly service: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Hex SHA-256 of the body. */
  readonly payloadHash: string;
  /**
   * Extra headers to sign, lowercase names. `host` and `x-amz-date` are added
   * here; anything S3 requires on top — `x-amz-content-sha256` — is the
   * caller's, which keeps this a plain SigV4 signer that Amazon's own published
   * test vectors can be run against.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** The moment the request is made. Signatures expire, so this is not decorative. */
  readonly now: Date;
};

/** `20260829T031500Z` and `20260829`. */
const stamps = (now: Date): { amzDate: string; date: string } => {
  const amzDate = `${now
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, '')
    .slice(0, 15)}Z`;
  return { amzDate, date: amzDate.slice(0, 8) };
};

/**
 * The Authorization header, plus the headers it commits to.
 *
 * Returns every header the request must carry: change one afterwards and the
 * signature no longer describes what was sent, which is the mistake this shape
 * is meant to make hard.
 */
export const signRequest = async (
  request: SignedRequest,
): Promise<Readonly<Record<string, string>>> => {
  const { amzDate, date } = stamps(request.now);

  const headers: Record<string, string> = {
    ...request.headers,
    host: request.host,
    'x-amz-date': amzDate,
  };

  // Signed in lowercase name order, values trimmed. The order is part of the
  // signature, so it is sorted rather than left to insertion.
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${(headers[name] ?? '').trim()}\n`)
    .join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    request.method,
    request.path,
    // No query string is used by any of the three operations. An empty line is
    // still required — S3 signs the absence.
    '',
    canonicalHeaders,
    signedHeaders,
    request.payloadHash,
  ].join('\n');

  const scope = `${date}/${request.region}/${request.service}/aws4_request`;
  const toSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    toHex(await sha256(utf8.encode(canonicalRequest))),
  ].join('\n');

  // The signing key is derived once per day, per region, per service — which is
  // what makes a leaked signature useless tomorrow, somewhere else.
  const dateKey = await hmac(utf8.encode(`AWS4${request.secretAccessKey}`), date);
  const regionKey = await hmac(dateKey, request.region);
  const serviceKey = await hmac(regionKey, request.service);
  const signingKey = await hmac(serviceKey, 'aws4_request');
  const signature = toHex(await hmac(signingKey, toSign));

  return {
    ...headers,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};
