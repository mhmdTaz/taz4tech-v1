import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BYTES } from '../domain/image';
import { createHttpImageFetcher } from './http-image-fetcher';

/**
 * The one place the shop fetches a URL somebody else wrote.
 *
 * Every rule in this adapter was argued in a comment and enforced by nothing —
 * it had no test of any kind, which mutation testing found only once it was
 * pointed past `domain/`. The rules are security rules: refuse `file:`, re-check
 * the scheme after a redirect, refuse a body too large before reading it. A
 * comment saying so is not a control.
 */

const PNG = new Uint8Array([137, 80, 78, 71]);

const stub = (impl: (url: URL, init: RequestInit) => Response | Promise<Response>) => {
  const fetch = vi.fn(impl);
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

/**
 * Response.url is read-only and empty on a hand-built Response.
 *
 * Real fetch always sets it, and the adapter re-parses it to re-check the
 * scheme after a redirect — so a stub that leaves it blank makes `new URL('')`
 * throw and every happy path come back as unreachable. Defined here rather than
 * per test, because forgetting it produces a plausible-looking failure that
 * says nothing about the code.
 */
const landingAt = (response: Response, url: string) => {
  // configurable, so a redirect case can override the default this sets.
  Object.defineProperty(response, 'url', { value: url, configurable: true });
  return response;
};

const ok = (
  body: Uint8Array,
  headers: Record<string, string> = {},
  url = 'https://s.example/a.png',
) =>
  landingAt(
    new Response(body as BodyInit, {
      status: 200,
      headers: { 'content-type': 'image/png', ...headers },
    }),
    url,
  );

const fetcher = createHttpImageFetcher();

afterEach(() => vi.unstubAllGlobals());

describe('what it refuses before making a request', () => {
  it('refuses something that is not a URL', async () => {
    const fetch = stub(() => ok(PNG));

    await expect(fetcher('not a url')).resolves.toEqual({
      ok: false,
      error: { tag: 'unreachable', reason: 'not a URL' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['file:', 'file:///etc/passwd'],
    ['ftp:', 'ftp://example.com/a.png'],
    ['data:', 'data:image/png;base64,iVBORw0KGgo='],
  ])('refuses %s without asking the network', async (scheme, url) => {
    /*
     * A file: URL in a supplier spreadsheet asks the server to read its own
     * disk and store the result as a product photograph. It is refused before
     * fetch is reached, which is the assertion that matters — refusing after
     * the request would already have done the damage for some schemes.
     */
    const fetch = stub(() => ok(PNG));
    const result = await fetcher(url);

    expect(result).toEqual({
      ok: false,
      error: { tag: 'unreachable', reason: `${scheme} is not fetched` },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['http://s.example/a.png', 'https://s.example/a.png'])('allows %s', async (url) => {
    stub(() => ok(PNG));
    await expect(fetcher(url)).resolves.toMatchObject({ ok: true });
  });
});

describe('the request it makes', () => {
  it('asks for an image and carries a timeout', async () => {
    // A supplier host that accepts a connection and then says nothing would
    // otherwise hold an import open until somebody noticed.
    const fetch = stub(() => ok(PNG));
    await fetcher('https://s.example/a.png');

    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).accept).toBe('image/*');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('follow');
  });
});

describe('what the far end can answer', () => {
  it('reports a refusal with its status', async () => {
    stub(() => new Response(null, { status: 404 }));
    await expect(fetcher('https://s.example/a.png')).resolves.toEqual({
      ok: false,
      error: { tag: 'not_ok', status: 404 },
    });
  });

  it('re-checks the scheme on the URL that answered', async () => {
    // fetch follows redirects itself, so the check before the request only ever
    // saw where it started. A redirect from https to file is one worth refusing.
    stub(() => landingAt(ok(PNG), 'file:///etc/passwd'));

    await expect(fetcher('https://s.example/a.png')).resolves.toEqual({
      ok: false,
      error: { tag: 'unreachable', reason: 'redirected to a scheme we do not fetch' },
    });
  });

  it('allows a redirect that stays on http or https', async () => {
    stub(() => landingAt(ok(PNG), 'https://cdn.example/a.png'));
    await expect(fetcher('https://s.example/a.png')).resolves.toMatchObject({ ok: true });
  });

  it('returns the bytes and the type', async () => {
    stub(() => ok(PNG));
    await expect(fetcher('https://s.example/a.png')).resolves.toEqual({
      ok: true,
      value: { bytes: PNG, contentType: 'image/png' },
    });
  });

  it.each([
    ['image/jpeg; charset=binary', 'image/jpeg'],
    ['IMAGE/PNG', 'image/png'],
    ['  image/webp  ', 'image/webp'],
    // The space BEFORE the semicolon is the one that reaches the trim. Headers
    // normalises leading and trailing whitespace on the way in, so a value
    // padded at the ends proves nothing — it was already trimmed by the
    // platform before this code saw it.
    ['image/png ; charset=binary', 'image/png'],
  ])('reduces %s to %s', async (header, expected) => {
    stub(() => ok(PNG, { 'content-type': header }));
    await expect(fetcher('https://s.example/a.png')).resolves.toMatchObject({
      value: { contentType: expected },
    });
  });

  it('survives a response with no content type at all', async () => {
    const response = landingAt(
      new Response(PNG as BodyInit, { status: 200 }),
      'https://s.example/a.png',
    );
    response.headers.delete('content-type');
    stub(() => response);

    await expect(fetcher('https://s.example/a.png')).resolves.toMatchObject({
      ok: true,
      value: { contentType: '' },
    });
  });

  it('turns a network failure into its name rather than a stack', async () => {
    stub(() => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });

    await expect(fetcher('https://s.example/a.png')).resolves.toEqual({
      ok: false,
      error: { tag: 'unreachable', reason: 'TimeoutError' },
    });
  });

  it('has an answer for something thrown that is not an Error', async () => {
    stub(() => {
      throw 'nope';
    });

    await expect(fetcher('https://s.example/a.png')).resolves.toEqual({
      ok: false,
      error: { tag: 'unreachable', reason: 'failed' },
    });
  });
});

describe('the size, which is checked twice', () => {
  it('refuses an oversized Content-Length WITHOUT reading the body', async () => {
    /*
     * The whole point of the header check. Reading 200 MB to discover it is
     * 200 MB is a denial of service a supplier can perform by accident, so
     * asserting the refusal is not enough — this asserts the body was never
     * touched.
     */
    let bodyRead = false;
    stub(() => {
      const response = landingAt(
        new Response(PNG as BodyInit, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(MAX_BYTES + 1) },
        }),
        'https://s.example/a.png',
      );
      const original = response.arrayBuffer.bind(response);
      response.arrayBuffer = async () => {
        bodyRead = true;
        return original();
      };
      return response;
    });

    await expect(fetcher('https://s.example/a.png')).resolves.toEqual({
      ok: false,
      error: { tag: 'too_large', byteLength: MAX_BYTES + 1 },
    });
    expect(bodyRead, 'the body was read despite an oversized Content-Length').toBe(false);
  });

  it('accepts a Content-Length of exactly the maximum', async () => {
    stub(() => ok(PNG, { 'content-length': String(MAX_BYTES) }));
    await expect(fetcher('https://s.example/a.png')).resolves.toMatchObject({ ok: true });
  });

  it('measures the bytes when the header LIES', async () => {
    // Content-Length is a claim, not a measurement. A supplier that understates
    // it must not get an oversized image into the store.
    const big = new Uint8Array(MAX_BYTES + 1);
    stub(() => ok(big, { 'content-length': '4' }));

    await expect(fetcher('https://s.example/a.png')).resolves.toEqual({
      ok: false,
      error: { tag: 'too_large', byteLength: MAX_BYTES + 1 },
    });
  });

  it('measures the bytes when there is no header at all', async () => {
    const big = new Uint8Array(MAX_BYTES + 1);
    const response = landingAt(
      new Response(big as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } }),
      'https://s.example/a.png',
    );
    response.headers.delete('content-length');
    stub(() => response);

    await expect(fetcher('https://s.example/a.png')).resolves.toMatchObject({
      error: { tag: 'too_large', byteLength: MAX_BYTES + 1 },
    });
  });

  it('accepts a body of exactly the maximum', async () => {
    const exact = new Uint8Array(MAX_BYTES);
    stub(() => ok(exact));
    await expect(fetcher('https://s.example/a.png')).resolves.toMatchObject({ ok: true });
  });
});
