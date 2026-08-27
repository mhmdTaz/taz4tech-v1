/**
 * Lebanon's eight governorates.
 *
 * A closed list rather than a free-text field: delivery is arranged per region,
 * and "Mount Lebanon" typed four different ways is four regions to anyone
 * counting. The customer's exact address is separate lines beside it.
 *
 * WHY THIS IS IN PLATFORM AND NOT IN A MODULE
 * -------------------------------------------
 * It started in the orders domain, where an order records where it is going.
 * Then delivery got a price per governorate, which is a shop policy and belongs
 * to store settings — and a module may not reach into another module's domain,
 * for good reasons. A shared vocabulary that two modules both need is what the
 * platform ring is for: `phone` already knows Lebanon's calling code, and this
 * knows its governorates. Neither is a business rule, both are facts about the
 * country the shop delivers in.
 *
 * The order matters and is not alphabetical: Beirut first because most deliveries
 * go there, then roughly north to south. A dropdown sorted alphabetically would
 * put Akkar — the furthest away and the rarest — near the top.
 */

export const REGIONS = [
  'beirut',
  'mount_lebanon',
  'north',
  'akkar',
  'bekaa',
  'baalbek_hermel',
  'south',
  'nabatieh',
] as const;

export type Region = (typeof REGIONS)[number];

export const isRegion = (value: string): value is Region =>
  (REGIONS as readonly string[]).includes(value);

/**
 * A complete price list: every governorate, no exceptions and no fallback.
 *
 * `Record` rather than `Partial<Record>` on purpose. A partial table needs a
 * default for the gaps, and a default is a second answer to "what does delivery
 * to Akkar cost" — the kind of ambiguity that quotes one number and charges
 * another. Adding a governorate to REGIONS breaks every construction of this
 * type until someone prices it, which is the correct amount of friction.
 */
export type ByRegion<T> = Readonly<Record<Region, T>>;

/** The same value for every governorate — how a flat rate is expressed here. */
export const sameEverywhere = <T>(value: T): ByRegion<T> =>
  Object.fromEntries(REGIONS.map((region) => [region, value])) as ByRegion<T>;
