/**
 * The admin gate: is this request allowed to change the catalogue?
 *
 * WHY EVERY PAGE AND EVERY ACTION CHECKS, RATHER THAN A LAYOUT OR MIDDLEWARE
 * -------------------------------------------------------------------------
 * A layout is not a security boundary. Client-side navigation can render a page
 * without re-running its layout, and a Server Action is invoked directly by URL
 * with no page render at all — so an action guarded only by the layout above it
 * is guarded by nothing.
 *
 * Middleware is not one either. CVE-2025-29927 was exactly this: a header that
 * made Next skip middleware entirely, turning every middleware-only auth check
 * into an open door. Next 16 has long since fixed it, but the lesson is
 * structural rather than about one bug — the check belongs next to the thing it
 * protects, where nothing in the framework's routing can route around it.
 *
 * So: requireAdmin() at the top of every admin page, and again at the top of
 * every admin Server Action. It is three extra lines and it cannot be bypassed
 * by a routing change.
 */

import { issueSession, readSession, SESSION_TTL_SECONDS, secretsMatch } from '@platform/auth';
import { type AdminConfig, getConfig } from '@platform/config';
import { createThrottle } from '@platform/throttle';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

const COOKIE_NAME = 'taz_admin';
export const LOGIN_PATH = '/admin/login';
export const IMPORT_PATH = '/admin/import';
export const PRODUCTS_PATH = '/admin/products';

/**
 * Two limits, because one is spoofable and one is not.
 *
 * The per-address limit is the useful one, but X-Forwarded-For is client-supplied
 * and an attacker behind many addresses defeats it. The global limit cannot be
 * defeated that way. It does mean a determined attacker can lock the operator
 * out of their own admin for fifteen minutes — a denial of service, deliberately
 * accepted in exchange for the password not being brute-forceable. The global
 * budget is set high enough that ordinary mistyping never reaches it.
 */
const WINDOW_MS = 15 * 60 * 1000;
const failuresByAddress = createThrottle({ limit: 5, windowMs: WINDOW_MS, now: Date.now });
const failuresOverall = createThrottle({ limit: 100, windowMs: WINDOW_MS, now: Date.now });
const GLOBAL_KEY = 'all';

/** The admin area exists only when it is configured; otherwise its URLs are 404. */
export const adminConfig = (): AdminConfig | null => getConfig().admin;

/**
 * 404, not 403.
 *
 * An unconfigured deploy should look like a site with no admin area at all,
 * rather than one advertising a login it cannot serve.
 */
export const requireAdminEnabled = (): AdminConfig => {
  const admin = adminConfig();
  if (admin === null) notFound();
  return admin;
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Whether the caller currently holds a valid session. Never throws. */
export const hasAdminSession = async (): Promise<boolean> => {
  const admin = adminConfig();
  if (admin === null) return false;

  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (token === undefined) return false;

  const session = await readSession(token, admin.sessionSecret, nowSeconds());
  return session.ok;
};

/**
 * Gate an admin page or action. Redirects to the login page when not signed in.
 *
 * Returns nothing useful on purpose: there is one operator, so a session carries
 * no identity worth passing around, and returning a truthy value invites callers
 * to write `if (await requireAdmin())` — which reads like a check but is one.
 */
export const requireAdmin = async (): Promise<void> => {
  requireAdminEnabled();
  if (!(await hasAdminSession())) redirect(LOGIN_PATH);
};

/** Best-effort caller address, used only as a throttle key. Never trusted for access. */
const callerKey = async (): Promise<string> => {
  const forwarded = (await headers()).get('x-forwarded-for');
  // The left-most entry is the original client as reported by the first proxy.
  // Spoofable, which is why the global limit exists alongside this one.
  return forwarded?.split(',')[0]?.trim() ?? 'unknown';
};

export type SignInResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'wrong_password' }
  | {
      readonly ok: false;
      readonly reason: 'too_many_attempts';
      readonly retryAfterSeconds: number;
    };

export const signIn = async (password: string): Promise<SignInResult> => {
  const admin = requireAdminEnabled();
  const key = await callerKey();

  for (const [throttle, throttleKey] of [
    [failuresByAddress, key],
    [failuresOverall, GLOBAL_KEY],
  ] as const) {
    const decision = throttle.check(throttleKey);
    if (!decision.allowed) {
      return {
        ok: false,
        reason: 'too_many_attempts',
        retryAfterSeconds: Math.ceil(decision.retryAfterMs / 1000),
      };
    }
  }

  if (!(await secretsMatch(password, admin.password))) {
    failuresByAddress.penalise(key);
    failuresOverall.penalise(GLOBAL_KEY);
    return { ok: false, reason: 'wrong_password' };
  }

  failuresByAddress.clear(key);

  const { token, session } = await issueSession(admin.sessionSecret, nowSeconds());

  (await cookies()).set(COOKIE_NAME, token, {
    httpOnly: true,
    // Off over plain HTTP, or the cookie is set and immediately discarded and
    // local development becomes a login loop with no error anywhere.
    secure: getConfig().isProduction,
    // 'lax' rather than 'strict': it blocks the cookie on cross-site POSTs,
    // which is the CSRF case, while still allowing a bookmark or a link to open
    // the admin already signed in. 'strict' would log the operator out every
    // time they arrived from anywhere else.
    sameSite: 'lax',
    // Never sent to the storefront, so an XSS anywhere in /en, /ar or /fr cannot
    // reach it even if httpOnly were somehow lost.
    path: '/admin',
    maxAge: SESSION_TTL_SECONDS,
    expires: new Date(session.expiresAt * 1000),
  });

  return { ok: true };
};

export const signOut = async (): Promise<void> => {
  (await cookies()).delete({ name: COOKIE_NAME, path: '/admin' });
};
