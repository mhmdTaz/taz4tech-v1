/**
 * The cart.
 *
 * IT IS A COOKIE, NOT A DOCUMENT
 * ------------------------------
 * A cart is a list of SKUs and quantities — a few hundred bytes — and storing
 * it server-side would buy a collection, a TTL job to sweep abandoned rows, an
 * id cookie anyway, and a database read on every page that shows a cart count.
 * None of that is paid for by anything a customer notices.
 *
 * It also fails safe. A corrupted cookie is an empty cart the customer can
 * refill, not a 500 and not a stale row nobody can explain.
 *
 * WHAT IS **NOT** IN IT
 * ---------------------
 * Prices. Never prices. The cookie is under the customer's control, so a cart
 * that carried its own prices would be a cart the customer could set the price
 * in. Every amount shown is read from the catalogue at render time; the cookie
 * says only *which* things and *how many*.
 *
 * PRICES ARE VAT-INCLUSIVE
 * ------------------------
 * Lebanese retail quotes what the customer pays, so a line total is the price
 * as listed and nothing is added on top. Whether a "of which VAT" line is shown
 * depends on registration, which is not settled — and it can be derived from
 * these same totals later without changing what anybody pays. Adding VAT on top
 * now would change every price on the strength of an open question.
 */

/** One line: a variant, and how many of it. */
export type CartLine = {
  readonly sku: string;
  readonly quantity: number;
};

export type Cart = {
  readonly lines: readonly CartLine[];
};

/**
 * Bounds, because the cookie is customer-controlled.
 *
 * Thirty lines is a large order for this shop and a small cookie; ninety-nine of
 * one thing is past the point where the operator would rather have a phone call
 * than a checkout.
 */
export const MAX_LINES = 30;
export const MAX_QUANTITY = 99;

export const EMPTY_CART: Cart = { lines: [] };

export type CartError =
  | { readonly tag: 'sku_empty' }
  | { readonly tag: 'quantity_out_of_range'; readonly quantity: number; readonly max: number }
  | { readonly tag: 'too_many_lines'; readonly max: number };

type CartResult = { ok: true; value: Cart } | { ok: false; error: CartError };

export const isEmpty = (cart: Cart): boolean => cart.lines.length === 0;

export const totalItems = (cart: Cart): number =>
  cart.lines.reduce((total, line) => total + line.quantity, 0);

export const quantityOf = (cart: Cart, sku: string): number =>
  cart.lines.find((line) => line.sku === sku)?.quantity ?? 0;

const validQuantity = (quantity: number): boolean =>
  Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_QUANTITY;

/**
 * Add to the cart, merging with a line that is already there.
 *
 * Merging rather than appending: two lines of the same SKU would price
 * correctly and then read as a mistake, and the customer would have to remove
 * both to change their mind.
 */
export const addToCart = (cart: Cart, sku: string, quantity: number): CartResult => {
  const cleaned = sku.trim();
  if (cleaned.length === 0) return { ok: false, error: { tag: 'sku_empty' } };
  if (!validQuantity(quantity)) {
    return { ok: false, error: { tag: 'quantity_out_of_range', quantity, max: MAX_QUANTITY } };
  }

  const existing = quantityOf(cart, cleaned);
  const wanted = existing + quantity;

  /*
   * Refused rather than clamped.
   *
   * Silently capping at ninety-nine would ship less than the customer asked for
   * and say nothing about it; the message names the limit so they can decide.
   */
  if (wanted > MAX_QUANTITY) {
    return {
      ok: false,
      error: { tag: 'quantity_out_of_range', quantity: wanted, max: MAX_QUANTITY },
    };
  }

  if (existing > 0) {
    return {
      ok: true,
      value: {
        lines: cart.lines.map((line) =>
          line.sku === cleaned ? { sku: cleaned, quantity: wanted } : line,
        ),
      },
    };
  }

  if (cart.lines.length >= MAX_LINES) {
    return { ok: false, error: { tag: 'too_many_lines', max: MAX_LINES } };
  }

  return { ok: true, value: { lines: [...cart.lines, { sku: cleaned, quantity }] } };
};

/** Set a line's quantity outright. Zero removes it, which is what a "0" in the box means. */
export const setQuantity = (cart: Cart, sku: string, quantity: number): CartResult => {
  const cleaned = sku.trim();
  if (cleaned.length === 0) return { ok: false, error: { tag: 'sku_empty' } };

  if (quantity === 0) return { ok: true, value: removeFromCart(cart, cleaned) };

  if (!validQuantity(quantity)) {
    return { ok: false, error: { tag: 'quantity_out_of_range', quantity, max: MAX_QUANTITY } };
  }

  // Setting a quantity on a line that is not there is a stale form, not a
  // request to add — the customer is looking at a cart that has moved on.
  if (quantityOf(cart, cleaned) === 0) return { ok: true, value: cart };

  return {
    ok: true,
    value: {
      lines: cart.lines.map((line) => (line.sku === cleaned ? { sku: cleaned, quantity } : line)),
    },
  };
};

export const removeFromCart = (cart: Cart, sku: string): Cart => ({
  lines: cart.lines.filter((line) => line.sku !== sku.trim()),
});

/** Drop lines whose SKU is no longer sellable, keeping the rest. */
export const keepOnly = (cart: Cart, skus: ReadonlySet<string>): Cart => ({
  lines: cart.lines.filter((line) => skus.has(line.sku)),
});

// ------------------------------------------------------------------ the cookie

type WireLine = { s: string; q: number };

/**
 * base64url of JSON, with one-letter keys.
 *
 * JSON because the format has to survive a SKU containing any character at all —
 * SKUs come from other people's spreadsheets, and a `sku:qty,sku:qty` join is
 * ambiguous the moment one contains a comma. base64url because it removes every
 * question about cookie quoting and encoding at once.
 *
 * The short keys are not premature: this rides on every request to the origin,
 * so a third off a thirty-line cart is a third off a cost paid continuously.
 */
export const formatCart = (cart: Cart): string => {
  const wire: WireLine[] = cart.lines.map((line) => ({ s: line.sku, q: line.quantity }));
  return toBase64Url(JSON.stringify(wire));
};

/**
 * Read a cart cookie. NEVER throws, and never returns something out of bounds.
 *
 * Anything unreadable is an empty cart: the customer refills it, which is
 * annoying, rather than meeting an error page, which is worse. Individual lines
 * are dropped rather than failing the whole cart, so one corrupt entry does not
 * cost the other twenty-nine.
 */
export const parseCart = (cookie: string | undefined): Cart => {
  if (cookie === undefined || cookie.length === 0) return EMPTY_CART;

  const decoded = fromBase64Url(cookie);
  if (decoded === null) return EMPTY_CART;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return EMPTY_CART;
  }
  if (!Array.isArray(parsed)) return EMPTY_CART;

  /*
   * Accumulated in a Map, which keeps insertion order and makes "have I seen
   * this SKU?" a lookup rather than an indexed read — an indexed read would need
   * a guard for an element the code just found, which is a branch that can never
   * be false sitting in a layer gated at 100%.
   */
  const quantities = new Map<string, number>();

  for (const entry of parsed) {
    const line = readLine(entry);
    if (line === null) continue;

    const current = quantities.get(line.sku);
    // Past the line limit, further NEW SKUs are dropped — but a duplicate of one
    // already kept still merges, so the cap costs the tail rather than the total.
    if (current === undefined && quantities.size >= MAX_LINES) continue;

    quantities.set(line.sku, Math.min((current ?? 0) + line.quantity, MAX_QUANTITY));
  }

  return { lines: [...quantities].map(([sku, quantity]) => ({ sku, quantity })) };
};

const readLine = (entry: unknown): CartLine | null => {
  if (typeof entry !== 'object' || entry === null) return null;
  const { s, q } = entry as Partial<WireLine>;

  if (typeof s !== 'string') return null;
  const sku = s.trim();
  if (sku.length === 0) return null;

  if (typeof q !== 'number' || !Number.isInteger(q) || q < 1) return null;

  /*
   * Clamped, not dropped.
   *
   * A quantity above the maximum is still a request for that item; keeping the
   * line at the cap preserves the intent. A quantity that is zero, negative or
   * not a number is not a request for anything, so that line goes.
   */
  return { sku, quantity: Math.min(q, MAX_QUANTITY) };
};

const toBase64Url = (value: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

const fromBase64Url = (value: string): string | null => {
  for (const character of value) {
    const allowed =
      (character >= 'A' && character <= 'Z') ||
      (character >= 'a' && character <= 'z') ||
      (character >= '0' && character <= '9') ||
      character === '-' ||
      character === '_';
    if (!allowed) return null;
  }

  try {
    const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
      c.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
};
