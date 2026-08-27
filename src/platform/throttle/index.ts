/**
 * A fixed-window failure counter, used to make the admin password unguessable
 * by brute force.
 *
 * One shared password on a public URL is only safe if guessing is slow. Without
 * this, an attacker gets thousands of attempts a second against a secret a human
 * chose; with it, they get a handful an hour.
 *
 * IN MEMORY, AND HONESTLY SO
 * --------------------------
 * State lives in the process. On the single Render instance this store runs on
 * that is exactly right, and it costs no Redis. If a second instance is ever
 * added the effective limit doubles — which is a reason to move this to the
 * database at that point, not a reason to build for it now. The failure mode is
 * a slightly looser limit, never an unlocked door.
 *
 * Only FAILURES are counted. A working session that reloads a page fifty times
 * must never be locked out, and counting successes would do exactly that.
 */

export type ThrottleDecision =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterMs: number };

export type Throttle = {
  /** Whether this key may try again right now. Consumes nothing. */
  check(key: string): ThrottleDecision;
  /** Record one failed attempt. */
  penalise(key: string): void;
  /** Forget the failures recorded against a key, after a successful login. */
  clear(key: string): void;
  /** Entries currently held. Exposed so a test can prove eviction happens. */
  size(): number;
};

export type ThrottleOptions = {
  /** Failures allowed inside one window before the key is locked out. */
  readonly limit: number;
  readonly windowMs: number;
  readonly now: () => number;
  /**
   * Hard cap on tracked keys. Without one, an attacker rotating source
   * addresses turns a defence into an unbounded map — the memory leak would be
   * easier to exploit than the password.
   */
  readonly maxKeys?: number;
};

const DEFAULT_MAX_KEYS = 10_000;

type Window = { failures: number; expiresAt: number };

export const createThrottle = (options: ThrottleOptions): Throttle => {
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const windows = new Map<string, Window>();

  const prune = (now: number): void => {
    for (const [key, window] of windows) {
      if (window.expiresAt <= now) windows.delete(key);
    }
  };

  const liveWindow = (key: string, now: number): Window | undefined => {
    const window = windows.get(key);
    if (window === undefined) return undefined;
    if (window.expiresAt <= now) {
      windows.delete(key);
      return undefined;
    }
    return window;
  };

  return {
    check(key) {
      const now = options.now();
      const window = liveWindow(key, now);
      if (window === undefined || window.failures < options.limit) {
        return { allowed: true, remaining: options.limit - (window?.failures ?? 0) };
      }
      return { allowed: false, retryAfterMs: window.expiresAt - now };
    },

    penalise(key) {
      const now = options.now();
      const window = liveWindow(key, now);

      if (window !== undefined) {
        // The window does NOT slide on a new failure. A sliding window lets a
        // patient attacker hold a key locked indefinitely, and — the common case,
        // not the attack — it would extend the operator's own lockout every time
        // they mistyped during it.
        window.failures++;
        return;
      }

      prune(now);
      if (windows.size >= maxKeys) {
        // Full of windows that are all still live, so every one belongs to a key
        // actively failing. Map preserves insertion order, so the first entry is
        // the oldest and is the least-bad thing to drop.
        for (const oldest of windows.keys()) {
          windows.delete(oldest);
          break;
        }
      }

      windows.set(key, { failures: 1, expiresAt: now + options.windowMs });
    },

    clear(key) {
      windows.delete(key);
    },

    size() {
      return windows.size;
    },
  };
};
