import { describe, expect, it } from 'vitest';
import { issueSession, readSession, SESSION_TTL_SECONDS, secretsMatch } from './index';

const SECRET = 'a-secret-long-enough-to-be-plausible-0123456789';
const NOW = 1_700_000_000;

describe('secretsMatch', () => {
  it('accepts identical strings', async () => {
    await expect(secretsMatch('hunter2', 'hunter2')).resolves.toBe(true);
  });

  it('rejects different strings of the same length', async () => {
    await expect(secretsMatch('hunter2', 'hunter3')).resolves.toBe(false);
  });

  it('rejects strings of different lengths without throwing', async () => {
    // Node's timingSafeEqual throws on a length mismatch, which would turn a
    // wrong password into a 500. This must simply be false.
    await expect(secretsMatch('short', 'considerably-longer')).resolves.toBe(false);
  });

  it('handles the empty string on either side', async () => {
    await expect(secretsMatch('', '')).resolves.toBe(true);
    await expect(secretsMatch('', 'x')).resolves.toBe(false);
    await expect(secretsMatch('x', '')).resolves.toBe(false);
  });

  it('compares by bytes, not by unicode normalisation', async () => {
    // 'é' as one code point vs 'e' + combining acute. They look identical and
    // must not authenticate each other.
    await expect(secretsMatch('café', 'café')).resolves.toBe(false);
  });
});

describe('issueSession', () => {
  it('produces a token in two dot-separated parts', async () => {
    const { token } = await issueSession(SECRET, NOW);
    expect(token.split('.')).toHaveLength(2);
  });

  it('sets expiry from the clock it is given, not from the wall clock', async () => {
    const { session } = await issueSession(SECRET, NOW);
    expect(session.issuedAt).toBe(NOW);
    expect(session.expiresAt).toBe(NOW + SESSION_TTL_SECONDS);
  });

  it('honours an explicit ttl', async () => {
    const { session } = await issueSession(SECRET, NOW, 60);
    expect(session.expiresAt).toBe(NOW + 60);
  });

  it('is url-safe, so it survives a cookie round trip unencoded', async () => {
    const { token } = await issueSession(SECRET, NOW);
    expect(token).toBe(encodeURIComponent(token));
  });
});

describe('readSession', () => {
  it('round-trips a token it issued', async () => {
    const { token, session } = await issueSession(SECRET, NOW);
    const result = await readSession(token, SECRET, NOW + 10);
    expect(result).toEqual({ ok: true, value: session });
  });

  it('rejects a token signed with a different secret', async () => {
    // The revocation story: changing ADMIN_SESSION_SECRET must log everyone out.
    const { token } = await issueSession(SECRET, NOW);
    const result = await readSession(token, `${SECRET}-rotated`, NOW + 10);
    expect(result).toEqual({ ok: false, error: { tag: 'bad_signature' } });
  });

  it('rejects a tampered payload', async () => {
    const { token } = await issueSession(SECRET, NOW, 1);
    const [, signature] = token.split('.');
    const forged = `${btoa(JSON.stringify({ issuedAt: NOW, expiresAt: NOW + 999_999 }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')}.${signature}`;

    const result = await readSession(forged, SECRET, NOW + 10);
    expect(result).toEqual({ ok: false, error: { tag: 'bad_signature' } });
  });

  it('rejects an expired token even though the signature is good', async () => {
    const { token } = await issueSession(SECRET, NOW, 60);
    const result = await readSession(token, SECRET, NOW + 61);
    expect(result).toEqual({ ok: false, error: { tag: 'expired', expiredAt: NOW + 60 } });
  });

  it('treats the exact expiry second as expired', async () => {
    const { token } = await issueSession(SECRET, NOW, 60);
    const result = await readSession(token, SECRET, NOW + 60);
    expect(result.ok).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['no separator', 'abcdef'],
    ['empty body', '.signature'],
    ['empty signature', 'body.'],
    ['three parts', 'a.b.c'],
  ])('rejects a %s token as malformed', async (_label, token) => {
    const result = await readSession(token, SECRET, NOW);
    expect(result.ok).toBe(false);
  });

  it('rejects an absurdly long token before doing any crypto', async () => {
    const result = await readSession(`${'a'.repeat(5000)}.b`, SECRET, NOW);
    expect(result).toEqual({ ok: false, error: { tag: 'malformed' } });
  });

  it('rejects a body outside the base64url alphabet', async () => {
    // Correctly signed, but the body contains a character atob might tolerate.
    // Two spellings of one payload must never both verify.
    const body = 'not+base64url';
    const { token } = await issueSession(SECRET, NOW);
    const [, signature] = token.split('.');
    const result = await readSession(`${body}.${signature}`, SECRET, NOW);
    expect(result.ok).toBe(false);
  });

  describe('a correctly signed body that is not a session', () => {
    // Signing INDEPENDENTLY here, rather than reusing a signature from another
    // token, is the whole point: pairing a body with someone else's signature
    // fails at bad_signature and never reaches the payload check, so the test
    // would pass while proving nothing.
    const sign = async (body: string): Promise<string> => {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const mac = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
      );
      return btoa(String.fromCharCode(...mac))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    };

    const encode = (value: string) =>
      btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

    const tokenFor = async (payload: string) => {
      const body = encode(payload);
      return `${body}.${await sign(body)}`;
    };

    it('signs the way the module does — negative control', async () => {
      // If this fails, every assertion below is meaningless: they would all be
      // rejecting on the signature rather than on the payload.
      const token = await tokenFor(JSON.stringify({ issuedAt: NOW, expiresAt: NOW + 60 }));
      await expect(readSession(token, SECRET, NOW)).resolves.toEqual({
        ok: true,
        value: { issuedAt: NOW, expiresAt: NOW + 60 },
      });
    });

    it('rejects a body that is in the alphabet but not a valid base64 length', async () => {
      // 'a' is a legal base64url character, and one character is not a legal
      // base64 group — atob throws rather than returning garbage. Correctly
      // signed, so only the decode can be what rejects it.
      const result = await readSession(`a.${await sign('a')}`, SECRET, NOW);
      expect(result).toEqual({ ok: false, error: { tag: 'malformed' } });
    });

    it.each([
      ['null', 'null'],
      ['a string', '"hello"'],
      ['a number', '42'],
      ['an array', '[]'],
      ['not json', 'not json at all'],
      ['an empty object', '{}'],
      ['string timestamps', '{"issuedAt":"1","expiresAt":"2"}'],
      ['an infinite expiry', '{"issuedAt":0,"expiresAt":1e999}'],
    ])('rejects %s as malformed', async (_label, payload) => {
      const result = await readSession(await tokenFor(payload), SECRET, NOW);
      expect(result).toEqual({ ok: false, error: { tag: 'malformed' } });
    });
  });
});
