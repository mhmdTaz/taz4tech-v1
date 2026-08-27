import { resetConfig } from '@platform/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The login path, which is the security boundary of the whole admin area.
 *
 * It is tested here rather than end-to-end for a specific reason: proving the
 * lockout works means failing five times in a row, and the throttle key for a
 * Playwright run is one loopback address — so an e2e test would lock every other
 * spec out of the admin for fifteen minutes. The control still has to be tested,
 * so it is tested where the clock and the request are both under control.
 *
 * next/headers and next/navigation are mocked because they only exist inside a
 * request. Everything else is the real implementation: the real HMAC, the real
 * throttle, the real config parsing.
 */

const cookieStore = {
  set: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

const requestHeaders = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
  headers: async () => ({ get: (name: string) => requestHeaders.get(name) ?? null }),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

const PASSWORD = 'a-long-enough-password';
const SECRET = 'x'.repeat(32);

/**
 * `process.env.X = undefined` assigns the STRING "undefined" — nine characters,
 * which the config then rejects as too short a password. Only delete removes a
 * variable, so these tests clear rather than assign.
 */
const clearAdminEnv = () => {
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_SESSION_SECRET;
};

const withEnv = (extra: Record<string, string>) => {
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
  clearAdminEnv();
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
  resetConfig();
};

/**
 * A fresh module instance per test.
 *
 * The throttles are module-level state on purpose — they have to outlive a
 * request — so a test that did not reset them would inherit the previous test's
 * failure count and pass or fail depending on ordering.
 */
const loadSession = async () => {
  vi.resetModules();
  return await import('./session');
};

beforeEach(() => {
  cookieStore.set.mockClear();
  cookieStore.get.mockReset();
  requestHeaders.clear();
  requestHeaders.set('x-forwarded-for', '203.0.113.7');
  withEnv({ ADMIN_PASSWORD: PASSWORD, ADMIN_SESSION_SECRET: SECRET });
});

afterEach(() => {
  clearAdminEnv();
  resetConfig();
});

describe('signIn', () => {
  it('accepts the configured password and sets a cookie', async () => {
    const { signIn } = await loadSession();
    expect(await signIn(PASSWORD)).toEqual({ ok: true });
    expect(cookieStore.set).toHaveBeenCalledOnce();
  });

  it('rejects a wrong password and sets nothing', async () => {
    const { signIn } = await loadSession();
    expect(await signIn('wrong')).toEqual({ ok: false, reason: 'wrong_password' });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it('rejects a password that is merely a prefix of the real one', async () => {
    const { signIn } = await loadSession();
    expect(await signIn(PASSWORD.slice(0, -1))).toEqual({ ok: false, reason: 'wrong_password' });
  });

  describe('the cookie it sets', () => {
    it('is httpOnly, same-site and scoped to /admin', async () => {
      const { signIn } = await loadSession();
      await signIn(PASSWORD);

      const [name, , options] = cookieStore.set.mock.calls[0] ?? [];
      expect(name).toBe('taz_admin');
      expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/admin' });
    });

    it('is not marked secure outside production, or development is a login loop', async () => {
      const { signIn } = await loadSession();
      await signIn(PASSWORD);
      expect(cookieStore.set.mock.calls[0]?.[2]).toMatchObject({ secure: false });
    });

    it('carries a token this module can read back', async () => {
      const { signIn, hasAdminSession } = await loadSession();
      await signIn(PASSWORD);

      const token = cookieStore.set.mock.calls[0]?.[1];
      cookieStore.get.mockReturnValue({ value: token });
      await expect(hasAdminSession()).resolves.toBe(true);
    });
  });

  describe('the lockout', () => {
    it('blocks the sixth attempt from one address', async () => {
      const { signIn } = await loadSession();
      for (let i = 0; i < 5; i++) {
        expect((await signIn('wrong')).ok).toBe(false);
      }

      const blocked = await signIn('wrong');
      expect(blocked).toMatchObject({ ok: false, reason: 'too_many_attempts' });
    });

    it('blocks the RIGHT password too, once locked out', async () => {
      // Otherwise the lockout is decorative: an attacker who guesses correctly
      // on attempt six is let straight in.
      const { signIn } = await loadSession();
      for (let i = 0; i < 5; i++) await signIn('wrong');

      expect(await signIn(PASSWORD)).toMatchObject({ reason: 'too_many_attempts' });
      expect(cookieStore.set).not.toHaveBeenCalled();
    });

    it('says how long is left, in whole seconds', async () => {
      const { signIn } = await loadSession();
      for (let i = 0; i < 5; i++) await signIn('wrong');

      const blocked = await signIn('wrong');
      if (blocked.ok || blocked.reason !== 'too_many_attempts') throw new Error('expected lockout');
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
      expect(Number.isInteger(blocked.retryAfterSeconds)).toBe(true);
    });

    it('counts each address separately', async () => {
      const { signIn } = await loadSession();
      for (let i = 0; i < 5; i++) await signIn('wrong');

      requestHeaders.set('x-forwarded-for', '198.51.100.9');
      expect(await signIn(PASSWORD)).toEqual({ ok: true });
    });

    it('reads only the left-most forwarded address, not the whole chain', async () => {
      const { signIn } = await loadSession();
      requestHeaders.set('x-forwarded-for', '203.0.113.7, 10.0.0.1, 10.0.0.2');
      for (let i = 0; i < 5; i++) await signIn('wrong');

      // Same client, different proxy hops appended — still the same key.
      requestHeaders.set('x-forwarded-for', '203.0.113.7, 10.9.9.9');
      expect(await signIn('wrong')).toMatchObject({ reason: 'too_many_attempts' });
    });

    it('falls back to one shared key when there is no forwarded address', async () => {
      const { signIn } = await loadSession();
      requestHeaders.delete('x-forwarded-for');

      for (let i = 0; i < 5; i++) await signIn('wrong');
      expect(await signIn('wrong')).toMatchObject({ reason: 'too_many_attempts' });
    });

    it('forgets an address after it succeeds', async () => {
      // Four mistypes then the right password must not leave the operator one
      // slip away from a lockout for the next quarter of an hour.
      const { signIn } = await loadSession();
      for (let i = 0; i < 4; i++) await signIn('wrong');
      expect(await signIn(PASSWORD)).toEqual({ ok: true });

      for (let i = 0; i < 5; i++) {
        expect(await signIn('wrong')).toEqual({ ok: false, reason: 'wrong_password' });
      }
    });

    it('holds a global limit that address rotation cannot defeat', async () => {
      // The per-address limit is spoofable — X-Forwarded-For is client-supplied.
      // The global one is what actually bounds a distributed guessing attack.
      const { signIn } = await loadSession();
      for (let attempt = 0; attempt < 100; attempt++) {
        requestHeaders.set('x-forwarded-for', `198.51.100.${attempt}`);
        await signIn('wrong');
      }

      requestHeaders.set('x-forwarded-for', '203.0.113.250');
      expect(await signIn('wrong')).toMatchObject({ reason: 'too_many_attempts' });
    });
  });
});

describe('when the admin area is not configured', () => {
  beforeEach(() => {
    withEnv({});
  });

  it('reports no session rather than throwing', async () => {
    const { hasAdminSession } = await loadSession();
    await expect(hasAdminSession()).resolves.toBe(false);
  });

  it('makes every admin URL a 404, not a login page', async () => {
    // A deploy with no admin configured should look like a site that has no
    // admin area, rather than one advertising a door it cannot open.
    const { requireAdminEnabled } = await loadSession();
    expect(() => requireAdminEnabled()).toThrow('NEXT_NOT_FOUND');
  });

  it('refuses to sign anyone in', async () => {
    const { signIn } = await loadSession();
    await expect(signIn('anything')).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('requireAdmin', () => {
  it('redirects to the login page without a session', async () => {
    const { requireAdmin } = await loadSession();
    cookieStore.get.mockReturnValue(undefined);
    await expect(requireAdmin()).rejects.toThrow('NEXT_REDIRECT:/admin/login');
  });

  it('redirects when the cookie holds a token signed with another secret', async () => {
    const { signIn } = await loadSession();
    await signIn(PASSWORD);
    const token = cookieStore.set.mock.calls[0]?.[1];

    // Rotate the secret — the documented way to revoke every open session.
    withEnv({ ADMIN_PASSWORD: PASSWORD, ADMIN_SESSION_SECRET: 'y'.repeat(32) });
    const rotated = await loadSession();
    cookieStore.get.mockReturnValue({ value: token });

    await expect(rotated.requireAdmin()).rejects.toThrow('NEXT_REDIRECT:/admin/login');
  });

  it('passes with a valid session', async () => {
    const { signIn, requireAdmin } = await loadSession();
    await signIn(PASSWORD);
    cookieStore.get.mockReturnValue({ value: cookieStore.set.mock.calls[0]?.[1] });

    await expect(requireAdmin()).resolves.toBeUndefined();
  });
});
