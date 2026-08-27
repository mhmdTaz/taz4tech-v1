/**
 * Small object helpers.
 *
 * `compact` exists because of exactOptionalPropertyTypes. Under that flag an
 * absent key and a key set to `undefined` are DIFFERENT types, so building an
 * options object means writing
 *
 *     ...(cursor === undefined ? {} : { cursor }),
 *
 * once per optional field. Six in a row is unreadable, and it is what pushed two
 * use cases past the cognitive-complexity limit. This says the same thing once.
 */

/** Collapses an intersection into one object type, so hovers stay readable. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Keys whose declared type admits `undefined` — the ones that become optional. */
type NullableKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T];
type SolidKeys<T> = Exclude<keyof T, NullableKeys<T>>;

/**
 * `{ a: string | undefined; b: number }` becomes `{ a?: string; b: number }`.
 *
 * The type transformation is the point, not a detail: returning `T` unchanged
 * would leave `undefined` in each property's type, and exactOptionalPropertyTypes
 * would still refuse to assign it where an optional key is expected.
 */
export type Compacted<T> = Simplify<
  { [K in SolidKeys<T>]: T[K] } & { [K in NullableKeys<T>]?: Exclude<T[K], undefined> }
>;

/**
 * The same object with every `undefined`-valued key removed.
 *
 * The cast is contained here and is sound: removing keys whose value is
 * `undefined` is precisely the difference between `{ a: string | undefined }`
 * and `{ a?: string }`. It is tested against that claim rather than assumed.
 */
export const compact = <T extends object>(source: T): Compacted<T> =>
  Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as Compacted<T>;
