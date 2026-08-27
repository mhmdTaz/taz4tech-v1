import { describe, expect, it } from 'vitest';
import { createThrottle } from './index';

const at = (start: number) => {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};

describe('createThrottle', () => {
  it('allows a key that has never failed', () => {
    const clock = at(0);
    const throttle = createThrottle({ limit: 3, windowMs: 1000, now: clock.now });
    expect(throttle.check('a')).toEqual({ allowed: true, remaining: 3 });
  });

  it('allows attempts up to the limit and blocks the one after', () => {
    const clock = at(0);
    const throttle = createThrottle({ limit: 3, windowMs: 1000, now: clock.now });

    throttle.penalise('a');
    expect(throttle.check('a')).toEqual({ allowed: true, remaining: 2 });
    throttle.penalise('a');
    throttle.penalise('a');
    expect(throttle.check('a')).toEqual({ allowed: false, retryAfterMs: 1000 });
  });

  it('counts keys independently', () => {
    const clock = at(0);
    const throttle = createThrottle({ limit: 1, windowMs: 1000, now: clock.now });
    throttle.penalise('a');
    expect(throttle.check('a').allowed).toBe(false);
    expect(throttle.check('b').allowed).toBe(true);
  });

  it('reports how long is left, not the whole window', () => {
    const clock = at(0);
    const throttle = createThrottle({ limit: 1, windowMs: 1000, now: clock.now });
    throttle.penalise('a');
    clock.advance(400);
    expect(throttle.check('a')).toEqual({ allowed: false, retryAfterMs: 600 });
  });

  it('lets the key back in once the window passes', () => {
    const clock = at(0);
    const throttle = createThrottle({ limit: 1, windowMs: 1000, now: clock.now });
    throttle.penalise('a');
    clock.advance(1000);
    expect(throttle.check('a')).toEqual({ allowed: true, remaining: 1 });
  });

  it('does not extend the lockout when a locked-out key fails again', () => {
    // Otherwise one mistyped password during an attack keeps the operator out
    // for as long as the attacker keeps trying.
    const clock = at(0);
    const throttle = createThrottle({ limit: 1, windowMs: 1000, now: clock.now });
    throttle.penalise('a');
    clock.advance(900);
    throttle.penalise('a');
    expect(throttle.check('a')).toEqual({ allowed: false, retryAfterMs: 100 });
  });

  it('forgets a key on clear, so a successful login resets the count', () => {
    const clock = at(0);
    const throttle = createThrottle({ limit: 2, windowMs: 1000, now: clock.now });
    throttle.penalise('a');
    throttle.clear('a');
    expect(throttle.check('a')).toEqual({ allowed: true, remaining: 2 });
  });

  it('drops expired windows rather than holding them forever', () => {
    const clock = at(0);
    const throttle = createThrottle({ limit: 5, windowMs: 1000, now: clock.now });
    throttle.penalise('a');
    expect(throttle.size()).toBe(1);
    clock.advance(1001);
    // A new key triggers the prune; the stale one must not survive it.
    throttle.penalise('b');
    expect(throttle.size()).toBe(1);
  });

  it('never exceeds maxKeys, even when every window is still live', () => {
    // The attack this defends against: rotating the source address to grow the
    // map without ever letting an entry expire.
    const clock = at(0);
    const throttle = createThrottle({ limit: 5, windowMs: 60_000, now: clock.now, maxKeys: 3 });
    for (let i = 0; i < 50; i++) throttle.penalise(`key-${i}`);
    expect(throttle.size()).toBe(3);
  });

  it('evicts the oldest key first when full', () => {
    const clock = at(0);
    const throttle = createThrottle({ limit: 1, windowMs: 60_000, now: clock.now, maxKeys: 2 });
    throttle.penalise('first');
    throttle.penalise('second');
    throttle.penalise('third');
    expect(throttle.check('first').allowed).toBe(true);
    expect(throttle.check('second').allowed).toBe(false);
    expect(throttle.check('third').allowed).toBe(false);
  });

  it('treats a key whose window expired as fresh, with no prune in between', () => {
    const clock = at(0);
    const throttle = createThrottle({ limit: 1, windowMs: 1000, now: clock.now });
    throttle.penalise('a');
    clock.advance(1001);
    expect(throttle.check('a')).toEqual({ allowed: true, remaining: 1 });
    throttle.penalise('a');
    expect(throttle.check('a')).toEqual({ allowed: false, retryAfterMs: 1000 });
  });
});
