/**
 * Clock — time as an injected dependency, never as a global.
 *
 * Two reasons this is a port rather than a direct Date.now() call:
 *
 * 1. The checkout reservation expires after 15 minutes and a TTL reaper releases
 *    the stock. Testing that with a real clock means a 15-minute test. With this,
 *    it is one line.
 * 2. Every timestamp is stored in UTC and displayed in Asia/Beirut. Lebanon
 *    observes DST, so "today's orders" is a moving target — the conversion has
 *    to be explicit and testable, not implicit in whatever the server's TZ is.
 */

export const STORE_TIME_ZONE = 'Asia/Beirut';

export interface Clock {
  /** Current instant, always UTC. */
  now(): Date;
  /** Milliseconds since epoch. */
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};

/** A clock frozen at a given instant, advanceable by hand. For tests only. */
export const fixedClock = (start: Date | number): Clock & { advance(ms: number): void } => {
  let current = typeof start === 'number' ? start : start.getTime();
  return {
    now: () => new Date(current),
    nowMs: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Locked decision: a checkout holds stock for 15 minutes. */
export const RESERVATION_TTL_MS = 15 * MINUTE_MS;

export const addMs = (at: Date, ms: number): Date => new Date(at.getTime() + ms);

export const hasElapsed = (since: Date, ms: number, clock: Clock): boolean =>
  clock.nowMs() - since.getTime() >= ms;

/**
 * The store-local calendar date (YYYY-MM-DD) for an instant.
 *
 * Used for daily run sheets and cash reconciliation, where "Tuesday's deliveries"
 * must mean Tuesday in Beirut regardless of where the server runs. Built from
 * Intl parts rather than string-slicing an ISO date, which would silently report
 * UTC days.
 */
export const storeDate = (at: Date, timeZone: string = STORE_TIME_ZONE): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};
