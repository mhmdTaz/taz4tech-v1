import { describe, expect, it } from 'vitest';
import { encodePath, hashPayload, signRequest } from './index';

/**
 * Signing is tested against Amazon's published vectors, not against itself.
 *
 * A signer can only be checked two ways: against a known-correct output, or by
 * making a real request. The second needs credentials and a bucket, so the
 * first is what CI can have — and it is the stronger of the two anyway, because
 * it pins the exact bytes rather than "the far end accepted it today".
 */

const VECTOR = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  host: 'example.amazonaws.com',
  now: new Date('2015-08-30T12:36:00Z'),
} as const;

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('hashPayload', () => {
  it('hashes an empty body to the value S3 expects for one', () => {
    // Not a corner case: every GET and HEAD sends it.
    return expect(hashPayload(new Uint8Array())).resolves.toBe(EMPTY_SHA256);
  });

  it('hashes bytes', async () => {
    // SHA-256 of "abc", which is the first vector in FIPS 180-4.
    await expect(hashPayload(new TextEncoder().encode('abc'))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('signRequest', () => {
  it('reproduces the get-vanilla vector from aws-sig-v4-test-suite', async () => {
    const headers = await signRequest({
      ...VECTOR,
      method: 'GET',
      path: '/',
      payloadHash: EMPTY_SHA256,
    });

    expect(headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('returns every header the signature commits to', async () => {
    // The caller must send exactly these. Returning them together is what stops
    // a request being signed for one set of headers and sent with another.
    const headers = await signRequest({
      ...VECTOR,
      method: 'GET',
      path: '/',
      payloadHash: EMPTY_SHA256,
    });

    expect(headers.host).toBe('example.amazonaws.com');
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });

  it('signs extra headers, in name order rather than the order given', async () => {
    const ordered = await signRequest({
      ...VECTOR,
      method: 'PUT',
      path: '/x',
      payloadHash: EMPTY_SHA256,
      headers: { 'content-type': 'image/png', 'x-amz-content-sha256': EMPTY_SHA256 },
    });
    const shuffled = await signRequest({
      ...VECTOR,
      method: 'PUT',
      path: '/x',
      payloadHash: EMPTY_SHA256,
      headers: { 'x-amz-content-sha256': EMPTY_SHA256, 'content-type': 'image/png' },
    });

    expect(ordered.Authorization).toBe(shuffled.Authorization);
    expect(ordered.Authorization).toContain(
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date',
    );
  });

  it.each([
    ['the method', { method: 'PUT' as const }],
    ['the path', { path: '/other' }],
    ['the payload', { payloadHash: EMPTY_SHA256.replace('e3b0', 'f3b0') }],
    ['the region', { region: 'eu-west-1' }],
    ['the day', { now: new Date('2015-08-31T12:36:00Z') }],
    ['the secret', { secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEz' }],
  ])('produces a different signature when %s changes', async (_what, override) => {
    const base = { ...VECTOR, method: 'GET' as const, path: '/', payloadHash: EMPTY_SHA256 };
    const [before, after] = await Promise.all([
      signRequest(base),
      signRequest({ ...base, ...override }),
    ]);

    expect(after.Authorization).not.toBe(before.Authorization);
  });

  it('is stable for the same inputs, so a retry sends the same bytes', async () => {
    const base = { ...VECTOR, method: 'GET' as const, path: '/', payloadHash: EMPTY_SHA256 };
    const [a, b] = await Promise.all([signRequest(base), signRequest(base)]);
    expect(a.Authorization).toBe(b.Authorization);
  });
});

describe('encodePath', () => {
  it('leaves a plain key alone', () => {
    expect(encodePath('/taz4tech/9f86d081')).toBe('/taz4tech/9f86d081');
  });

  it('keeps the slashes that separate segments', () => {
    // Encoding those would ask for one object with a slash in its name.
    expect(encodePath('/a/b/c')).toBe('/a/b/c');
  });

  it.each([
    ['a space', '/a b', '/a%20b'],
    ['an apostrophe encodeURIComponent leaves alone', "/a'b", '/a%27b'],
    ['the other four encodeURIComponent skips', '/!()*', '/%21%28%29%2A'],
  ])('encodes %s', (_what, input, expected) => {
    // S3 signs these encoded. A path that disagrees with its signature by one
    // character is a 403 with nothing in it to explain why.
    expect(encodePath(input)).toBe(expected);
  });
});
