import { unwrapOrThrow } from '@platform/result';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStoredImage } from '../domain/image';
import { createR2ImageRepository } from './r2-image-repository';

/**
 * Tested against a stubbed fetch rather than a bucket.
 *
 * There are no R2 credentials in CI and there should not be: a test suite that
 * needs a live vendor account is a test suite that goes red when somebody
 * else's billing lapses. What can be checked without one is everything this
 * adapter is actually responsible for — the URL it builds, the headers it
 * signs, the body it sends, and what it does with each answer it can get back.
 *
 * The signing itself is checked against Amazon's published vectors in
 * platform/s3. Between the two, the only thing left untested is whether
 * Cloudflare agrees, and that is what the first real request will say.
 */

const CONFIG = {
  accountId: 'abc123',
  bucket: 'taz4tech-media',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
} as const;

const NOW = new Date('2026-08-29T08:00:00Z');
const ID = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const BYTES = new Uint8Array([137, 80, 78, 71]);

const repository = () => createR2ImageRepository(CONFIG, () => NOW);

const stub = (response: Response) => {
  const fetch = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

const lastCall = (fetch: ReturnType<typeof stub>) => {
  const [url, init] = (fetch.mock.calls as unknown as [string, RequestInit][])[0] ?? [];
  return { url, init, headers: (init?.headers ?? {}) as Record<string, string> };
};

const image = () =>
  unwrapOrThrow(
    createStoredImage({
      storeId: 'taz4tech',
      id: ID,
      contentType: 'image/png',
      bytes: BYTES,
      storedAt: NOW,
    }),
  );

afterEach(() => vi.unstubAllGlobals());

describe('findById', () => {
  it('asks for the object at <bucket>/<storeId>/<id>', async () => {
    const fetch = stub(
      new Response(BYTES, { status: 200, headers: { 'content-type': 'image/png' } }),
    );

    await repository().findById('taz4tech', ID);

    const { url, init } = lastCall(fetch);
    expect(init?.method).toBe('GET');
    expect(url).toBe(`https://abc123.r2.cloudflarestorage.com/taz4tech-media/taz4tech/${ID}`);
  });

  it('puts the tenant in the KEY, so a wrong one cannot reach another shop', async () => {
    // Isolation by key rather than by filter: the wrong storeId asks for an
    // object that does not exist, instead of one that exists and is somebody
    // else's.
    const fetch = stub(new Response(null, { status: 404 }));

    await repository().findById('someone-else', ID);

    expect(lastCall(fetch).url).toContain(`/taz4tech-media/someone-else/${ID}`);
  });

  it('signs the request for s3 in R2s one region', async () => {
    const fetch = stub(
      new Response(BYTES, { status: 200, headers: { 'content-type': 'image/png' } }),
    );

    await repository().findById('taz4tech', ID);

    const { headers } = lastCall(fetch);
    expect(headers.Authorization).toContain('Credential=AKIDEXAMPLE/20260829/auto/s3/aws4_request');
    expect(headers['x-amz-date']).toBe('20260829T080000Z');
    // Required by S3 on every request, not only the ones with a body.
    expect(headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('returns the image', async () => {
    stub(new Response(BYTES, { status: 200, headers: { 'content-type': 'image/png' } }));

    const found = await repository().findById('taz4tech', ID);

    expect(found?.id).toBe(ID);
    expect(found?.contentType).toBe('image/png');
    expect(found?.bytes).toEqual(BYTES);
  });

  it('takes the stored date from Last-Modified rather than inventing one', async () => {
    stub(
      new Response(BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png', 'last-modified': 'Tue, 01 Jul 2025 10:00:00 GMT' },
      }),
    );

    const found = await repository().findById('taz4tech', ID);
    expect(found?.storedAt).toEqual(new Date('2025-07-01T10:00:00Z'));
  });

  it('is null for an object that is not there', async () => {
    stub(new Response(null, { status: 404 }));
    await expect(repository().findById('taz4tech', ID)).resolves.toBeNull();
  });

  it('THROWS on anything else, rather than reporting a broken bucket as an empty one', async () => {
    // The difference between "this product has no photograph" and "the store is
    // down" is the difference between a page and an incident.
    stub(new Response('slow down', { status: 503 }));
    await expect(repository().findById('taz4tech', ID)).rejects.toThrow(/503/);
  });

  it('refuses an object whose type this shop does not store', async () => {
    // A bucket is writable by other things. An SVG served back as a product
    // photograph is a script the storefront would embed.
    stub(new Response(BYTES, { status: 200, headers: { 'content-type': 'image/svg+xml' } }));
    await expect(repository().findById('taz4tech', ID)).rejects.toThrow(/not an image/);
  });

  it('trims the type when the space is before the semicolon', async () => {
    // Headers normalises whitespace at the ends of a value, so a padded header
    // never reaches the trim. This one does.
    stub(
      new Response(BYTES, { status: 200, headers: { 'content-type': 'image/png ; charset=x' } }),
    );
    await expect(repository().findById('taz4tech', ID)).resolves.toMatchObject({
      contentType: 'image/png',
    });
  });

  it('stamps the read with the clock when there is no Last-Modified', async () => {
    // Without the header there is nothing to take the date from, so it falls
    // back to now. Untested, this silently became new Date(null) — the epoch.
    stub(new Response(BYTES, { status: 200, headers: { 'content-type': 'image/png' } }));
    await expect(repository().findById('taz4tech', ID)).resolves.toMatchObject({ storedAt: NOW });
  });

  it('refuses an object the domain would not accept, rather than returning it', async () => {
    // The bucket is writable by other things. An object stored under a key that
    // is not a SHA-256 cannot be a StoredImage, and saying so is better than
    // handing the storefront something the domain rejected.
    stub(new Response(BYTES, { status: 200, headers: { 'content-type': 'image/png' } }));
    await expect(repository().findById('taz4tech', 'not-a-hash')).rejects.toThrow(
      /violates an invariant/,
    );
  });

  it('uses a real clock when it is not given one, which is how production builds it', async () => {
    // The composition root calls this with one argument. Every other test here
    // injects a clock, so the default parameter was never once executed.
    stub(new Response(BYTES, { status: 200, headers: { 'content-type': 'image/png' } }));
    const found = await createR2ImageRepository(CONFIG).findById('taz4tech', ID);

    expect(found?.storedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(found?.storedAt.getTime())).toBe(false);
  });

  it('reads the type without its charset', async () => {
    stub(
      new Response(BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png; charset=binary' },
      }),
    );
    await expect(repository().findById('taz4tech', ID)).resolves.toMatchObject({
      contentType: 'image/png',
    });
  });
});

describe('exists', () => {
  it('uses HEAD, so asking does not drag the bytes back', async () => {
    // Re-importing a spreadsheet asks this once per row.
    const fetch = stub(new Response(null, { status: 200 }));

    await repository().exists('taz4tech', ID);

    expect(lastCall(fetch).init?.method).toBe('HEAD');
  });

  it.each([
    [200, true],
    [404, false],
  ])('answers %s with %s', async (status, expected) => {
    stub(new Response(null, { status }));
    await expect(repository().exists('taz4tech', ID)).resolves.toBe(expected);
  });

  it('throws on a fault rather than answering "no"', async () => {
    // Answering no would re-upload every image on the next import.
    stub(new Response(null, { status: 500 }));
    await expect(repository().exists('taz4tech', ID)).rejects.toThrow(/500/);
  });
});

describe('save', () => {
  it('PUTs the bytes with their content type', async () => {
    const fetch = stub(new Response(null, { status: 200 }));

    await repository().save(image());

    const { url, init, headers } = lastCall(fetch);
    expect(init?.method).toBe('PUT');
    expect(url).toContain(`/taz4tech-media/taz4tech/${ID}`);
    expect(headers['content-type']).toBe('image/png');
    expect(init?.body).toEqual(BYTES);
  });

  it('signs the body, not an empty payload', async () => {
    const fetch = stub(new Response(null, { status: 200 }));

    await repository().save(image());

    /*
     * SHA-256 of the four PNG magic bytes, taken from node:crypto rather than
     * from this adapter — a test that asserts whatever the code produced would
     * pass just as happily on the empty hash, which is the actual bug worth
     * catching here. Signing an empty payload while sending a body is a 403
     * that only happens in production, where the bucket is real.
     */
    expect(lastCall(fetch).headers['x-amz-content-sha256']).toBe(
      '0f4636c78f65d3639ece5a064b5ae753e3408614a14fb18ab4d7540d2c248543',
    );
  });

  it('throws when the store refuses the write', async () => {
    stub(new Response('AccessDenied', { status: 403 }));
    await expect(repository().save(image())).rejects.toThrow(/403/);
  });
});
