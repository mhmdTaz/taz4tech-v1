import { describe, expect, it } from 'vitest';
import { isRegion, REGIONS, type Region, sameEverywhere } from './index';

describe('the governorates', () => {
  it('is all eight of them', () => {
    // Lebanon has eight. A list of seven means one governorate's customers
    // cannot check out at all.
    expect(REGIONS).toHaveLength(8);
  });

  it('lists Beirut first', () => {
    // Not alphabetical: most deliveries go to Beirut, and alphabetical would put
    // Akkar — the furthest and the rarest — near the top of every dropdown.
    expect(REGIONS[0]).toBe('beirut');
  });

  it('has no duplicates', () => {
    expect(new Set(REGIONS).size).toBe(REGIONS.length);
  });

  it('recognises every one of them', () => {
    for (const region of REGIONS) expect(isRegion(region)).toBe(true);
  });

  it('refuses anything else', () => {
    for (const value of ['', 'Beirut', 'beyrouth', 'tripoli', 'toString', '__proto__']) {
      expect(isRegion(value)).toBe(false);
    }
  });
});

describe('a value for every governorate', () => {
  it('covers all eight', () => {
    const table = sameEverywhere(0);
    for (const region of REGIONS) expect(table[region]).toBe(0);
  });

  it('is how a flat rate is expressed', () => {
    // The migration from one flat fee to a table is exactly this: the old number,
    // everywhere. It meant that already; now it says so.
    const table = sameEverywhere(250);
    expect(Object.values(table).every((cents) => cents === 250)).toBe(true);
  });

  it('has no keys beyond the governorates', () => {
    const table: Record<string, unknown> = sameEverywhere(0);
    expect(Object.keys(table).sort()).toEqual([...(REGIONS as readonly Region[])].sort());
  });
});
