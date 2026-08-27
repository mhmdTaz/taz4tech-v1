import { err, ok } from '@platform/result';
import { describe, expect, it, vi } from 'vitest';
import type { StockRepository } from '../contracts';
import type { StockLevel } from '../domain/stock';
import {
  availabilityBySku,
  MAX_SKU_LOOKUP,
  makeAdjustStock,
  makeGetStockLevels,
  makeSetStockLevel,
} from './stock-levels';

const NOW = new Date('2026-08-27T10:00:00Z');

const level = (sku: string, overrides: Partial<StockLevel> = {}): StockLevel => ({
  storeId: 'taz4tech',
  sku,
  policy: 'tracked',
  onHand: 5,
  updatedAt: NOW,
  ...overrides,
});

const repository = (overrides: Partial<StockRepository> = {}): StockRepository => ({
  findBySku: vi.fn(async () => null),
  findBySkus: vi.fn(async () => []),
  save: vi.fn(async () => undefined),
  adjust: vi.fn(async () => err({ tag: 'untracked' as const, sku: 'SKU-1' })),
  ...overrides,
});

describe('getStockLevels', () => {
  it('returns a map keyed by SKU', async () => {
    // A map, not an array: every caller is about to ask "what about this SKU?"
    // inside a render loop, and an array makes that a linear scan.
    const repo = repository({ findBySkus: vi.fn(async () => [level('A'), level('B')]) });
    const get = makeGetStockLevels({ repository: repo, storeId: 'taz4tech' });

    const map = await get(['A', 'B']);
    expect(map.get('A')?.sku).toBe('A');
    expect(map.size).toBe(2);
  });

  it('leaves a SKU with no record absent rather than inventing one', async () => {
    // Absence is what the domain reads as untracked. Filling it in with a zero
    // here would turn every unimported SKU into "out of stock".
    const repo = repository({ findBySkus: vi.fn(async () => [level('A')]) });
    const get = makeGetStockLevels({ repository: repo, storeId: 'taz4tech' });

    expect((await get(['A', 'B'])).has('B')).toBe(false);
  });

  it('asks once for a repeated SKU', async () => {
    const findBySkus = vi.fn(
      async (_storeId: string, _skus: readonly string[]) => [] as StockLevel[],
    );
    const get = makeGetStockLevels({ repository: repository({ findBySkus }), storeId: 'taz4tech' });

    await get(['A', 'A', 'A']);
    expect(findBySkus).toHaveBeenCalledWith('taz4tech', ['A']);
  });

  it('drops blank SKUs instead of querying for them', async () => {
    const findBySkus = vi.fn(
      async (_storeId: string, _skus: readonly string[]) => [] as StockLevel[],
    );
    const get = makeGetStockLevels({ repository: repository({ findBySkus }), storeId: 'taz4tech' });

    await get(['A', '   ', '']);
    expect(findBySkus).toHaveBeenCalledWith('taz4tech', ['A']);
  });

  it('does not query at all for an empty list', async () => {
    const findBySkus = vi.fn(
      async (_storeId: string, _skus: readonly string[]) => [] as StockLevel[],
    );
    const get = makeGetStockLevels({ repository: repository({ findBySkus }), storeId: 'taz4tech' });

    expect((await get([])).size).toBe(0);
    expect(findBySkus).not.toHaveBeenCalled();
  });

  it('bounds how many SKUs one call can ask about', async () => {
    // A page of products has tens of variants, not thousands. A longer list is
    // a crafted request, and $in with thousands of terms is a slow query.
    const findBySkus = vi.fn(
      async (_storeId: string, _skus: readonly string[]) => [] as StockLevel[],
    );
    const get = makeGetStockLevels({ repository: repository({ findBySkus }), storeId: 'taz4tech' });

    await get(Array.from({ length: MAX_SKU_LOOKUP + 50 }, (_, i) => `SKU-${i}`));
    expect(findBySkus.mock.calls[0]?.[1]).toHaveLength(MAX_SKU_LOOKUP);
  });
});

describe('setStockLevel', () => {
  const setter = (repo: StockRepository) =>
    makeSetStockLevel({ repository: repo, storeId: 'taz4tech', now: () => NOW });

  it('saves a validated level', async () => {
    const save = vi.fn(async (_level: StockLevel) => undefined);
    const result = await setter(repository({ save }))({
      sku: 'SKU-1',
      policy: 'tracked',
      onHand: 7,
    });

    expect(result).toEqual({ ok: true, value: level('SKU-1', { onHand: 7 }) });
    expect(save).toHaveBeenCalledOnce();
  });

  it('stamps the tenant from the container, never from the caller', async () => {
    const save = vi.fn(async (_level: StockLevel) => undefined);
    await setter(repository({ save }))({ sku: 'SKU-1', policy: 'tracked', onHand: 1 });

    expect(save.mock.calls[0]?.[0]).toMatchObject({ storeId: 'taz4tech' });
  });

  it('refuses an invalid level without writing anything', async () => {
    const save = vi.fn(async (_level: StockLevel) => undefined);
    const result = await setter(repository({ save }))({
      sku: 'SKU-1',
      policy: 'tracked',
      onHand: -3,
    });

    expect(result).toEqual({
      ok: false,
      error: { tag: 'invalid', reason: { tag: 'quantity_negative', onHand: -3 } },
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('stamps updatedAt from the injected clock', async () => {
    const save = vi.fn(async (_level: StockLevel) => undefined);
    await setter(repository({ save }))({ sku: 'SKU-1', policy: 'tracked', onHand: 1 });

    expect(save.mock.calls[0]?.[0]).toMatchObject({ updatedAt: NOW });
  });
});

describe('adjustStock', () => {
  const adjuster = (repo: StockRepository) =>
    makeAdjustStock({ repository: repo, storeId: 'taz4tech', now: () => NOW });

  it('passes a decrement straight through to the atomic update', async () => {
    // The application layer must NOT read, decide, then write: that reopens the
    // race the conditional update exists to close.
    const adjust = vi.fn(async () => ok(level('SKU-1', { onHand: 4 })));
    const result = await adjuster(repository({ adjust }))('SKU-1', -1);

    expect(adjust).toHaveBeenCalledWith('taz4tech', 'SKU-1', -1, NOW);
    expect(result.ok).toBe(true);
  });

  it('refuses a delta of zero rather than succeeding at nothing', async () => {
    // A caller asking to move nothing has computed a quantity wrongly, and
    // quietly succeeding hides it.
    const adjust = vi.fn();
    expect(await adjuster(repository({ adjust }))('SKU-1', 0)).toEqual({
      ok: false,
      error: { tag: 'invalid_delta', delta: 0 },
    });
    expect(adjust).not.toHaveBeenCalled();
  });

  it('refuses a fractional delta', async () => {
    expect((await adjuster(repository())('SKU-1', -0.5)).ok).toBe(false);
  });

  it('reports insufficient stock with what is actually there', async () => {
    const adjust = vi.fn(async () =>
      err({ tag: 'insufficient' as const, sku: 'SKU-1', onHand: 2 }),
    );
    expect(await adjuster(repository({ adjust }))('SKU-1', -5)).toEqual({
      ok: false,
      error: { tag: 'failed', reason: { tag: 'insufficient', sku: 'SKU-1', onHand: 2 } },
    });
  });

  it('reports untracked distinctly from insufficient', async () => {
    // They mean opposite things to a sale: untracked sells freely, exhausted
    // must not. Collapsing them would block orders for everything uncounted.
    const adjust = vi.fn(async () => err({ tag: 'untracked' as const, sku: 'SKU-1' }));
    expect(await adjuster(repository({ adjust }))('SKU-1', -1)).toEqual({
      ok: false,
      error: { tag: 'failed', reason: { tag: 'untracked', sku: 'SKU-1' } },
    });
  });
});

describe('availabilityBySku', () => {
  it('reads a missing SKU as in stock', async () => {
    const map = availabilityBySku(['A'], new Map());
    expect(map.get('A')).toBe('in_stock');
  });

  it('reads an exhausted tracked SKU as out of stock', () => {
    const map = availabilityBySku(['A'], new Map([['A', level('A', { onHand: 0 })]]));
    expect(map.get('A')).toBe('out_of_stock');
  });

  it('covers every SKU asked about, not only the ones with records', () => {
    const map = availabilityBySku(['A', 'B'], new Map([['A', level('A')]]));
    expect([...map.keys()]).toEqual(['A', 'B']);
  });
});
