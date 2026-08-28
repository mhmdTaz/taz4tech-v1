import { err, ok, type Result } from '@platform/result';
import { describe, expect, it, vi } from 'vitest';
import type { FetchedImage, FetchFailure, ImageRepository } from '../contracts';
import type { StoredImage } from '../domain/image';
import { MAX_BYTES } from '../domain/image';
import { describeIngestFailure, type IngestFailure, makeIngestImage } from './ingest-image';

const NOW = new Date('2026-08-28T10:00:00Z');
const HASH = 'b'.repeat(64);

type Fetched = Result<FetchedImage, FetchFailure>;

const harness = (options: { fetched?: Fetched; exists?: boolean } = {}) => {
  const save = vi.fn(async (_image: StoredImage) => undefined);
  const repository = {
    findById: vi.fn(async () => null),
    exists: vi.fn(async () => options.exists ?? false),
    save,
  } satisfies ImageRepository;

  const fetched: Fetched =
    options.fetched ?? ok({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' });

  const fetcher = vi.fn(async (_url: string) => fetched);

  return {
    save,
    repository,
    fetcher,
    written: (): StoredImage | undefined => save.mock.calls[0]?.[0],
    run: makeIngestImage({
      repository,
      fetch: fetcher,
      sha256Hex: () => HASH,
      storeId: 'taz4tech',
      now: () => NOW,
    }),
  };
};

describe('taking a copy of a supplier image', () => {
  it('stores it and hands back a path on our own origin', async () => {
    const h = harness();
    const result = await h.run('https://supplier.example.com/laptop.jpg');

    expect(result).toEqual({ ok: true, value: { path: `/media/${HASH}`, stored: true } });
    expect(h.written()).toMatchObject({ id: HASH, contentType: 'image/jpeg', byteLength: 3 });
  });

  it('names the file by its CONTENT, not by where it came from', async () => {
    // Which is what makes the URL cacheable forever and makes forty rows sharing
    // one photograph cost one stored image.
    const h = harness();
    await h.run('https://supplier.example.com/some/deep/path.jpg?v=4');

    expect(h.written()?.id).toBe(HASH);
  });

  it('does not fetch twice, but does not store twice either', async () => {
    const h = harness({ exists: true });
    const result = await h.run('https://supplier.example.com/laptop.jpg');

    expect(result).toEqual({ ok: true, value: { path: `/media/${HASH}`, stored: false } });
    expect(h.save).not.toHaveBeenCalled();
  });

  it('does not re-validate bytes it already holds', async () => {
    /*
     * Re-importing last month's sheet asks "have I got this" once per row and
     * the answer is almost always yes. Re-running the domain checks to reach a
     * conclusion the database already holds would be work for nothing.
     */
    const h = harness({
      exists: true,
      // Bytes the domain would refuse, if it were asked.
      fetched: ok({ bytes: new Uint8Array(0), contentType: 'application/pdf' }),
    });

    expect((await h.run('https://supplier.example.com/x')).ok).toBe(true);
  });
});

describe('when the supplier misbehaves', () => {
  it('reports a 404 rather than throwing', async () => {
    // A supplier CDN that is down must not stop four hundred products importing.
    const h = harness({ fetched: err({ tag: 'not_ok', status: 404 }) });

    expect(await h.run('https://supplier.example.com/gone.jpg')).toEqual({
      ok: false,
      error: { tag: 'fetch_failed', reason: { tag: 'not_ok', status: 404 } },
    });
    expect(h.save).not.toHaveBeenCalled();
  });

  it('reports an unreachable host', async () => {
    const h = harness({ fetched: err({ tag: 'unreachable', reason: 'ENOTFOUND' }) });
    expect((await h.run('https://nope.invalid/x.jpg')).ok).toBe(false);
  });

  it('refuses an SVG served as an image', async () => {
    // The security case. Storing it would put a supplier's scriptable document
    // on our own origin.
    const h = harness({
      fetched: ok({ bytes: new Uint8Array([60, 115]), contentType: 'image/svg+xml' }),
    });

    const result = await h.run('https://supplier.example.com/logo.svg');
    expect(result).toEqual({
      ok: false,
      error: { tag: 'rejected', reason: { tag: 'unsupported_type', contentType: 'image/svg+xml' } },
    });
    expect(h.save).not.toHaveBeenCalled();
  });

  it('refuses an HTML error page served with a 200', async () => {
    // Every CDN does this eventually. Without the content-type check it would be
    // stored as a product photograph.
    const h = harness({
      fetched: ok({ bytes: new Uint8Array([60, 33]), contentType: 'text/html' }),
    });

    expect((await h.run('https://supplier.example.com/missing.jpg')).ok).toBe(false);
  });

  it('refuses an empty body behind a 200', async () => {
    const h = harness({ fetched: ok({ bytes: new Uint8Array(0), contentType: 'image/png' }) });
    expect((await h.run('https://supplier.example.com/empty.png')).ok).toBe(false);
  });

  it('refuses something past the size cap', async () => {
    const h = harness({
      fetched: ok({ bytes: new Uint8Array(MAX_BYTES + 1), contentType: 'image/png' }),
    });

    const result = await h.run('https://supplier.example.com/huge.png');
    expect(result).toMatchObject({
      ok: false,
      error: { tag: 'rejected', reason: { tag: 'too_large' } },
    });
  });
});

describe('explaining a failure on an import receipt', () => {
  const reason = (failure: IngestFailure) => describeIngestFailure(failure);

  it('says what the server answered', () => {
    expect(reason({ tag: 'fetch_failed', reason: { tag: 'not_ok', status: 403 } })).toBe(
      'the server answered 403',
    );
  });

  it('says the host could not be reached, and why', () => {
    expect(
      reason({ tag: 'fetch_failed', reason: { tag: 'unreachable', reason: 'ENOTFOUND' } }),
    ).toContain('ENOTFOUND');
  });

  it('says the size in a unit a person reads', () => {
    expect(
      reason({ tag: 'fetch_failed', reason: { tag: 'too_large', byteLength: 9_000_000 } }),
    ).toBe('the file is larger than 5 MB');
    expect(
      reason({
        tag: 'rejected',
        reason: { tag: 'too_large', byteLength: 9_000_000, max: MAX_BYTES },
      }),
    ).toBe('the file is larger than 5 MB');
  });

  it('names the type that was refused', () => {
    expect(
      reason({
        tag: 'rejected',
        reason: { tag: 'unsupported_type', contentType: 'image/svg+xml' },
      }),
    ).toContain('image/svg+xml');
  });

  it('says an empty file is empty', () => {
    expect(reason({ tag: 'rejected', reason: { tag: 'empty' } })).toContain('empty');
  });

  it('still says something for a reason nobody expected', () => {
    // id_invalid cannot come from this path — the id is computed here — but a
    // receipt that renders "undefined" is worse than one that is vague.
    expect(reason({ tag: 'rejected', reason: { tag: 'id_invalid', id: 'x' } })).toBe(
      'the image could not be stored',
    );
  });
});
