/**
 * Admin session tokens, and comparing secrets without leaking them by timing.
 *
 * Deliberately small: one operator, one password, one signed cookie. There are
 * no user accounts to model yet, and inventing a users collection now would be
 * building the wrong thing before knowing who else will ever log in.
 *
 * WHY A SIGNED TOKEN AND NOT A SESSION TABLE
 * ------------------------------------------
 * A session table needs a write on every login and a read on every request, and
 * it earns that cost by making revocation instant. With exactly one operator,
 * revocation means changing ADMIN_SESSION_SECRET — which invalidates every
 * outstanding token at once, because they are all signed with it. That is the
 * same guarantee at none of the cost.
 *
 * The token is NOT a JWT. A JWT carries an algorithm field the verifier is
 * expected to trust, which is the source of its most famous vulnerability. Here
 * the algorithm is fixed by this file and nothing in the token can change it.
 */

import { err, ok, type Result } from '@platform/result';

/** Fixed by this file. Nothing in the token influences it. */
const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' } as const;

/** Rejected before any parsing. A token this long is an attack, not a session. */
const MAX_TOKEN_BYTES = 4096;

const utf8 = new TextEncoder();

const importKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', utf8.encode(secret), ALGORITHM, false, ['sign']);

const hmac = async (secret: string, message: string): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.sign(ALGORITHM.name, await importKey(secret), utf8.encode(message)),
  );

/**
 * Constant-time comparison of two secrets of ANY length.
 *
 * The usual byte-wise loop leaks the length of the expected value, because it
 * has to bail when the lengths differ. Comparing HMACs under a key generated
 * fresh for this process removes that: both sides become 32 bytes whatever went
 * in, and an attacker cannot precompute against a key they have never seen.
 */
const blindingKey = crypto.getRandomValues(new Uint8Array(32)).join('-');

export const secretsMatch = async (a: string, b: string): Promise<boolean> => {
  const [left, right] = await Promise.all([hmac(blindingKey, a), hmac(blindingKey, b)]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return difference === 0;
};

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

const fromBase64Url = (value: string): Uint8Array | null => {
  // Reject anything outside the alphabet FIRST: atob is lenient about some
  // inputs and permissive decoding is how two different strings end up with the
  // same signature.
  for (const character of value) {
    const isAllowed =
      (character >= 'A' && character <= 'Z') ||
      (character >= 'a' && character <= 'z') ||
      (character >= '0' && character <= '9') ||
      character === '-' ||
      character === '_';
    if (!isAllowed) return null;
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

export type AdminSession = {
  /** Seconds since the epoch, matching the cookie's own expiry. */
  readonly issuedAt: number;
  readonly expiresAt: number;
};

export type SessionError =
  | { readonly tag: 'malformed' }
  | { readonly tag: 'bad_signature' }
  | { readonly tag: 'expired'; readonly expiredAt: number };

/** How long a login lasts. Long enough to import a catalogue without re-typing. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export const issueSession = async (
  secret: string,
  nowSeconds: number,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<{ token: string; session: AdminSession }> => {
  const session: AdminSession = {
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + ttlSeconds,
  };
  const body = toBase64Url(utf8.encode(JSON.stringify(session)));
  const signature = toBase64Url(await hmac(secret, body));
  return { token: `${body}.${signature}`, session };
};

/** Split on the FIRST dot only, and reject anything that is not exactly two parts. */
const splitToken = (token: string): { body: string; signature: string } | null => {
  if (token.length === 0 || token.length > MAX_TOKEN_BYTES) return null;

  const separator = token.indexOf('.');
  if (separator === -1) return null;

  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (body.length === 0 || signature.length === 0 || signature.includes('.')) return null;

  return { body, signature };
};

/** Bytes -> AdminSession, or null. Only ever called on a payload we signed. */
const parsePayload = (decoded: Uint8Array): AdminSession | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const { issuedAt, expiresAt } = parsed as Record<string, unknown>;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;

  return { issuedAt: issuedAt as number, expiresAt: expiresAt as number };
};

/**
 * Verify, then parse. Never the other way round.
 *
 * The payload is attacker-supplied until the signature says otherwise, so it is
 * not fed to JSON.parse until the HMAC has matched. Parsing first would run
 * untrusted input through a parser for no reason at all.
 */
export const readSession = async (
  token: string,
  secret: string,
  nowSeconds: number,
): Promise<Result<AdminSession, SessionError>> => {
  const parts = splitToken(token);
  if (parts === null) return err({ tag: 'malformed' });

  const expected = toBase64Url(await hmac(secret, parts.body));
  if (!(await secretsMatch(parts.signature, expected))) return err({ tag: 'bad_signature' });

  const decoded = fromBase64Url(parts.body);
  if (decoded === null) return err({ tag: 'malformed' });

  const session = parsePayload(decoded);
  if (session === null) return err({ tag: 'malformed' });

  // Expiry is checked AFTER the signature, so an expired token and a forged one
  // are distinguishable to us but not to whoever sent it: both get a login page.
  if (session.expiresAt <= nowSeconds) {
    return err({ tag: 'expired', expiredAt: session.expiresAt });
  }

  return ok(session);
};
