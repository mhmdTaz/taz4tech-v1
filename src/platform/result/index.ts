/**
 * Result<T, E> — the return type for *expected* failures.
 *
 * The rule this codebase follows:
 *
 *   Expected failure  -> Result.err(...)   "the phone number is malformed",
 *                                          "that variant is out of stock"
 *   Unexpected failure -> throw            "Mongo is unreachable", "bug"
 *
 * Expected failures are part of a use case's contract, so they belong in its
 * type signature where the compiler forces the caller to handle them. Throwing
 * for them hides the contract and makes exhaustive handling impossible to check.
 *
 * E is deliberately generic rather than an Error subclass: domain errors are
 * plain data (a tag + fields), so they serialise across the wire and translate
 * into any of en/ar/fr without carrying a stack trace into the response.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Transform the success value, leaving a failure untouched. */
export const map = <T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;

/** Transform the failure, leaving a success untouched. */
export const mapErr = <T, E, F>(r: Result<T, E>, f: (error: E) => F): Result<T, F> =>
  r.ok ? r : err(f(r.error));

/** Chain a second fallible step. Short-circuits on the first failure. */
export const andThen = <T, U, E, F>(
  r: Result<T, E>,
  f: (value: T) => Result<U, F>,
): Result<U, E | F> => (r.ok ? f(r.value) : r);

export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T => (r.ok ? r.value : fallback);

/**
 * Throw on failure. Use ONLY at a boundary that has already proven the value is
 * fine (tests, or a code path where err() is a bug). Never in a use case.
 */
export const unwrapOrThrow = <T, E>(r: Result<T, E>): T => {
  if (r.ok) return r.value;
  throw new Error(`unwrapOrThrow on Err: ${JSON.stringify(r.error)}`);
};

/**
 * Collect many Results into one. Fails with EVERY error, not just the first —
 * a form with three bad fields should report three problems, not one per
 * round-trip.
 */
export const allOf = <T, E>(results: readonly Result<T, E>[]): Result<T[], E[]> => {
  const values: T[] = [];
  const errors: E[] = [];
  for (const r of results) {
    if (r.ok) values.push(r.value);
    else errors.push(r.error);
  }
  return errors.length > 0 ? err(errors) : ok(values);
};

/** Exhaustiveness helper: makes a missed union member a compile error. */
export const assertNever = (x: never, message = 'Unreachable'): never => {
  throw new Error(`${message}: ${JSON.stringify(x)}`);
};
