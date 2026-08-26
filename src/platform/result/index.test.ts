import { describe, expect, it } from 'vitest';
import {
  allOf,
  andThen,
  assertNever,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  unwrapOr,
  unwrapOrThrow,
} from './index';

describe('Result', () => {
  it('narrows to Ok and Err through the guards', () => {
    const good = ok(1);
    const bad = err('boom');
    expect(isOk(good)).toBe(true);
    expect(isErr(good)).toBe(false);
    expect(isOk(bad)).toBe(false);
    expect(isErr(bad)).toBe(true);
  });

  it('map transforms a success and passes a failure through untouched', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
    expect(map(err<string>('nope'), (n: number) => n * 3)).toEqual(err('nope'));
  });

  it('mapErr transforms a failure and leaves a success alone', () => {
    expect(mapErr(err('a'), (e) => `${e}!`)).toEqual(err('a!'));
    expect(mapErr(ok(1), (e: string) => `${e}!`)).toEqual(ok(1));
  });

  it('andThen chains and short-circuits on the first failure', () => {
    const double = (n: number) => ok(n * 2);
    const fail = () => err('stop');
    expect(andThen(ok(2), double)).toEqual(ok(4));
    expect(andThen(ok(2), fail)).toEqual(err('stop'));
    expect(andThen(err<string>('early'), double)).toEqual(err('early'));
  });

  it('unwrapOr returns the fallback only on failure', () => {
    expect(unwrapOr(ok(5), 0)).toBe(5);
    expect(unwrapOr(err('x') as never, 0)).toBe(0);
  });

  it('unwrapOrThrow returns the value, or throws with the error in the message', () => {
    expect(unwrapOrThrow(ok('v'))).toBe('v');
    expect(() => unwrapOrThrow(err({ tag: 'bad' }))).toThrow(/"tag":"bad"/);
  });

  it('allOf reports EVERY failure, not just the first', () => {
    const result = allOf([ok(1), err('a'), ok(2), err('b')]);
    expect(result).toEqual(err(['a', 'b']));
  });

  it('allOf collects values in order when everything succeeds', () => {
    expect(allOf([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
  });

  it('allOf on an empty list succeeds with an empty list', () => {
    expect(allOf([])).toEqual(ok([]));
  });

  it('assertNever throws when an impossible value reaches it', () => {
    expect(() => assertNever('x' as never)).toThrow(/Unreachable/);
    expect(() => assertNever('x' as never, 'unhandled status')).toThrow(/unhandled status/);
  });
});
