import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_TYPES,
  CACHE_CONTROL,
  createStoredImage,
  imagePath,
  isImageType,
  MAX_BYTES,
} from './image';

const ID = 'a'.repeat(64);
const NOW = new Date('2026-08-28T10:00:00Z');

const image = (overrides: Partial<Parameters<typeof createStoredImage>[0]> = {}) =>
  createStoredImage({
    storeId: 'taz4tech',
    id: ID,
    contentType: 'image/jpeg',
    bytes: new Uint8Array([1, 2, 3]),
    storedAt: NOW,
    ...overrides,
  });

describe('what may be stored', () => {
  it('accepts a small JPEG', () => {
    const result = image();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.byteLength).toBe(3);
  });

  it('accepts every format the optimiser can read', () => {
    for (const contentType of ACCEPTED_TYPES) {
      expect(image({ contentType }).ok, contentType).toBe(true);
    }
  });

  it('REFUSES an SVG', () => {
    /*
     * The one that matters. An SVG is a document, not a picture: it can carry
     * script and external references, and serving one from our own origin runs
     * a supplier's markup inside the shop's security context.
     */
    expect(image({ contentType: 'image/svg+xml' })).toEqual({
      ok: false,
      error: { tag: 'unsupported_type', contentType: 'image/svg+xml' },
    });
  });

  it('refuses anything that is not an image at all', () => {
    for (const contentType of ['application/pdf', 'text/html', 'application/octet-stream', '']) {
      expect(image({ contentType }).ok, contentType).toBe(false);
    }
  });

  it('refuses AVIF, which the optimiser cannot decode in this Next build', () => {
    expect(image({ contentType: 'image/avif' }).ok).toBe(false);
  });

  it('names the type problem even on an enormous file', () => {
    // A row pointing at a 200 MB PDF should be told it is not an image, which is
    // the thing the spreadsheet author can see and fix.
    const result = image({
      contentType: 'application/pdf',
      bytes: new Uint8Array(MAX_BYTES + 1),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('unsupported_type');
  });

  it('refuses an empty body', () => {
    // A 200 response with nothing in it is what a broken CDN returns, and
    // storing it would put a broken image on the storefront rather than none.
    expect(image({ bytes: new Uint8Array(0) })).toEqual({ ok: false, error: { tag: 'empty' } });
  });

  it('caps uploads at five megabytes, written out rather than derived', () => {
    /*
     * Stated as a number on purpose. Every other test here expresses the limit
     * as MAX_BYTES, so all of them keep passing if the constant is wrong — a
     * cap of five BYTES refuses "exactly the maximum plus one" just as happily
     * as five megabytes does, and every product photograph with it.
     *
     * This is the one assertion in the file that could notice.
     */
    expect(MAX_BYTES).toBe(5_242_880);
  });

  it('accepts exactly the maximum, and refuses one byte more', () => {
    expect(image({ bytes: new Uint8Array(MAX_BYTES) }).ok).toBe(true);

    const over = image({ bytes: new Uint8Array(MAX_BYTES + 1) });
    expect(over).toEqual({
      ok: false,
      error: { tag: 'too_large', byteLength: MAX_BYTES + 1, max: MAX_BYTES },
    });
  });
});

describe('the id', () => {
  it('has to be a SHA-256 in hex', () => {
    // Content-addressed is the whole basis for caching these forever. An id that
    // is not derived from the bytes is an id whose bytes can change underneath a
    // year-long cache header.
    for (const id of ['', 'abc', ID.toUpperCase(), `${ID}0`, 'z'.repeat(64)]) {
      // The rejected id is carried back: this is the value that came out of a
      // supplier sheet, and naming it is the difference between a fixable row
      // and "an image failed".
      expect(image({ id }), id).toEqual({ ok: false, error: { tag: 'id_invalid', id } });
    }
  });

  it('accepts a real one', () => {
    expect(
      image({ id: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' }).ok,
    ).toBe(true);
  });
});

describe('serving it', () => {
  it('is a same-origin path, so next/image needs no allowlist', () => {
    expect(imagePath(ID)).toBe(`/media/${ID}`);
  });

  it('is cacheable forever, because different bytes are a different id', () => {
    expect(CACHE_CONTROL).toContain('immutable');
    expect(CACHE_CONTROL).toContain('max-age=31536000');
  });
});

describe('recognising a type', () => {
  it('says yes only to the four', () => {
    expect(isImageType('image/png')).toBe(true);
    expect(isImageType('image/svg+xml')).toBe(false);
    expect(isImageType('IMAGE/PNG')).toBe(false);
  });
});
