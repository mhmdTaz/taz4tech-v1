import { describe, expect, it } from 'vitest';
import {
  addMs,
  DAY_MS,
  fixedClock,
  HOUR_MS,
  hasElapsed,
  MINUTE_MS,
  RESERVATION_TTL_MS,
  storeDate,
  systemClock,
} from './index';

describe('systemClock', () => {
  it('reports the current instant', () => {
    const before = Date.now();
    const now = systemClock.nowMs();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(systemClock.now()).toBeInstanceOf(Date);
  });
});

describe('fixedClock', () => {
  it('does not move on its own', () => {
    const clock = fixedClock(new Date('2026-08-26T10:00:00Z'));
    expect(clock.nowMs()).toBe(clock.nowMs());
    expect(clock.now().toISOString()).toBe('2026-08-26T10:00:00.000Z');
  });

  it('accepts a millisecond start as well as a Date', () => {
    expect(fixedClock(0).nowMs()).toBe(0);
  });

  it('advances only when told to', () => {
    const clock = fixedClock(1000);
    clock.advance(500);
    expect(clock.nowMs()).toBe(1500);
  });
});

describe('reservation window', () => {
  it('is the 15 minutes the plan locked in', () => {
    expect(RESERVATION_TTL_MS).toBe(15 * 60_000);
  });

  it('has not elapsed at 14:59 and has at exactly 15:00', () => {
    const start = new Date('2026-08-26T10:00:00Z');
    const clock = fixedClock(start);

    clock.advance(RESERVATION_TTL_MS - 1000);
    expect(hasElapsed(start, RESERVATION_TTL_MS, clock)).toBe(false);

    clock.advance(1000);
    // Boundary is inclusive: at exactly the TTL the hold is released, so stock
    // is never held for 15 minutes and one millisecond.
    expect(hasElapsed(start, RESERVATION_TTL_MS, clock)).toBe(true);
  });
});

describe('time constants and arithmetic', () => {
  it('relates minutes, hours and days', () => {
    expect(MINUTE_MS).toBe(60_000);
    expect(HOUR_MS).toBe(60 * MINUTE_MS);
    expect(DAY_MS).toBe(24 * HOUR_MS);
  });

  it('addMs returns a new Date without mutating the original', () => {
    const start = new Date('2026-08-26T10:00:00Z');
    const later = addMs(start, HOUR_MS);
    expect(later.toISOString()).toBe('2026-08-26T11:00:00.000Z');
    expect(start.toISOString()).toBe('2026-08-26T10:00:00.000Z');
  });
});

describe('storeDate', () => {
  it('reports the Beirut calendar day, not the UTC one', () => {
    // 22:30 UTC on the 26th is 01:30 on the 27th in Beirut (UTC+3 in summer).
    // A run sheet built from the UTC date would put this delivery on the wrong day.
    expect(storeDate(new Date('2026-08-26T22:30:00Z'))).toBe('2026-08-27');
  });

  it('agrees with UTC in the middle of the Beirut day', () => {
    expect(storeDate(new Date('2026-08-26T09:00:00Z'))).toBe('2026-08-26');
  });

  it('handles the winter offset, when Beirut is UTC+2', () => {
    expect(storeDate(new Date('2026-01-15T22:30:00Z'))).toBe('2026-01-16');
    expect(storeDate(new Date('2026-01-15T21:30:00Z'))).toBe('2026-01-15');
  });

  it('accepts an explicit time zone for reports run from elsewhere', () => {
    expect(storeDate(new Date('2026-08-26T22:30:00Z'), 'UTC')).toBe('2026-08-26');
  });

  it('always returns a zero-padded ISO calendar date', () => {
    expect(storeDate(new Date('2026-01-05T09:00:00Z'))).toBe('2026-01-05');
  });
});
