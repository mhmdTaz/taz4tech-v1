/**
 * The URL shape of a filtered listing.
 *
 * Delivery-layer concern: these names are part of the public URL, so they are
 * short and stable. The use case does the bounding — nothing here trusts a
 * value, it only decodes it.
 *
 *   ?q=laptop&brand=Lenovo&brand=Dell&opt.Colour=Black&min=100&max=500&cursor=…
 */

export type RawSearchParams = Record<string, string | string[] | undefined>;

export type ListingParams = {
  readonly q: string;
  readonly brands: string[];
  readonly options: { name: string; values: string[] }[];
  readonly minCents?: number;
  readonly maxCents?: number;
  readonly cursor?: string;
};

const OPTION_PREFIX = 'opt.';

const many = (value: string | string[] | undefined): string[] => {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((entry) => entry.trim().length > 0);
};

const one = (value: string | string[] | undefined): string | undefined => {
  const [first] = many(value);
  return first;
};

/** Dollars in the URL, cents everywhere else. `100.50` becomes 10050. */
const toCents = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const amount = Number(value.replace(/[^0-9.]/g, ''));
  return Number.isFinite(amount) ? Math.round(amount * 100) : undefined;
};

export const parseListingParams = (params: RawSearchParams): ListingParams => {
  const options: { name: string; values: string[] }[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (!key.startsWith(OPTION_PREFIX)) continue;
    const name = key.slice(OPTION_PREFIX.length);
    const values = many(value);
    if (name.length > 0 && values.length > 0) options.push({ name, values });
  }

  const minCents = toCents(one(params.min));
  const maxCents = toCents(one(params.max));

  return {
    q: one(params.q) ?? '',
    brands: many(params.brand),
    options,
    ...(minCents === undefined ? {} : { minCents }),
    ...(maxCents === undefined ? {} : { maxCents }),
    ...(one(params.cursor) === undefined ? {} : { cursor: one(params.cursor) as string }),
  };
};

/**
 * The URL with one facet value toggled on or off.
 *
 * Always drops the cursor: keeping it would land the customer on page four of a
 * result set that no longer has four pages.
 */
export const toggledHref = (
  base: string,
  current: ListingParams,
  facet: { kind: 'brand' } | { kind: 'option'; name: string },
  value: string,
): string => {
  const query = new URLSearchParams();
  if (current.q.length > 0) query.set('q', current.q);

  const isBrand = facet.kind === 'brand';
  const brands = isBrand ? toggle(current.brands, value) : current.brands;
  for (const brand of brands) query.append('brand', brand);

  for (const option of current.options) {
    const values =
      facet.kind === 'option' && facet.name === option.name
        ? toggle(option.values, value)
        : option.values;
    for (const entry of values) query.append(`${OPTION_PREFIX}${option.name}`, entry);
  }

  // A brand-new option axis the customer has just started filtering on.
  if (facet.kind === 'option' && !current.options.some((o) => o.name === facet.name)) {
    query.append(`${OPTION_PREFIX}${facet.name}`, value);
  }

  if (current.minCents !== undefined) query.set('min', String(current.minCents / 100));
  if (current.maxCents !== undefined) query.set('max', String(current.maxCents / 100));

  const search = query.toString();
  return search.length === 0 ? base : `${base}?${search}`;
};

const toggle = (values: readonly string[], value: string): string[] =>
  values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];

/**
 * The same filtered view, at the next page.
 *
 * Every active filter is carried across. Paginating with only the cursor would
 * silently drop the filters, so page two of "Lenovo laptops under $500" would
 * quietly become page two of everything.
 */
export const withCursor = (base: string, params: ListingParams, cursor: string): string => {
  const query = new URLSearchParams();
  if (params.q.length > 0) query.set('q', params.q);
  for (const brand of params.brands) query.append('brand', brand);
  for (const option of params.options) {
    for (const value of option.values) query.append(`${OPTION_PREFIX}${option.name}`, value);
  }
  if (params.minCents !== undefined) query.set('min', String(params.minCents / 100));
  if (params.maxCents !== undefined) query.set('max', String(params.maxCents / 100));
  query.set('cursor', cursor);
  return `${base}?${query.toString()}`;
};

/** True when anything is filtering the results. */
export const hasActiveFilters = (params: ListingParams): boolean =>
  params.q.length > 0 ||
  params.brands.length > 0 ||
  params.options.length > 0 ||
  params.minCents !== undefined ||
  params.maxCents !== undefined;
