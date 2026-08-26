/**
 * Money types, separated from the operations.
 *
 * Not ceremony: allocate.ts needs the Money type, and index.ts needs to re-export
 * allocate. If the type lived in index.ts those two files would import each
 * other, and the no-circular boundary rule would (rightly) reject it. A leaf
 * module of pure type declarations breaks the cycle.
 */

export type Currency = 'USD';

declare const brand: unique symbol;

/** An exact amount of money. Construct via the helpers; never build one by hand. */
export type Money = {
  readonly cents: number;
  readonly currency: Currency;
  readonly [brand]?: 'Money';
};

export type MoneyError =
  | { readonly tag: 'not_an_integer'; readonly cents: number }
  | { readonly tag: 'not_finite'; readonly cents: number }
  | { readonly tag: 'unparsable'; readonly input: string }
  | { readonly tag: 'fractional_quantity'; readonly quantity: number }
  | { readonly tag: 'currency_mismatch'; readonly left: Currency; readonly right: Currency }
  | { readonly tag: 'negative_not_allowed'; readonly cents: number };
