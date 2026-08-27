/**
 * Reading and writing stock.
 *
 * Thin on purpose. The interesting rules are in the domain (what "no record"
 * means) and in the repository (how a decrement cannot race); this layer bounds
 * the input and hands back something the delivery layer can use directly.
 */

import { err, ok, type Result } from '@platform/result';
import type { AdjustFailure, StockRepository } from '../contracts';
import {
  availabilityOf,
  createStockLevel,
  type StockError,
  type StockLevel,
} from '../domain/stock';

/** More SKUs than a page of products has variants is a crafted request. */
export const MAX_SKU_LOOKUP = 500;

export type StockMap = ReadonlyMap<string, StockLevel>;

export type GetStockLevels = (skus: readonly string[]) => Promise<StockMap>;

/**
 * SKU -> level, for a page of products.
 *
 * A Map rather than an array, because every caller is about to ask "what about
 * this SKU?" and an array makes that a linear scan inside a render loop.
 * Missing SKUs are simply absent, which the domain reads as untracked.
 */
export const makeGetStockLevels =
  (deps: { repository: StockRepository; storeId: string }): GetStockLevels =>
  async (skus) => {
    const wanted = [...new Set(skus.filter((sku) => sku.trim().length > 0))].slice(
      0,
      MAX_SKU_LOOKUP,
    );
    if (wanted.length === 0) return new Map();

    const levels = await deps.repository.findBySkus(deps.storeId, wanted);
    return new Map(levels.map((level) => [level.sku, level]));
  };

export type SetStockLevelInput = {
  readonly sku: string;
  readonly policy: StockLevel['policy'];
  readonly onHand: number;
};

export type SetStockLevelError = { readonly tag: 'invalid'; readonly reason: StockError };

export type SetStockLevel = (
  input: SetStockLevelInput,
) => Promise<Result<StockLevel, SetStockLevelError>>;

/**
 * Set a SKU's level outright — a stock take, not a sale.
 *
 * Deliberately NOT how a sale moves stock. This overwrites, so two people
 * counting the same shelf would each overwrite the other; a sale uses adjust(),
 * which is relative and atomic.
 */
export const makeSetStockLevel =
  (deps: { repository: StockRepository; storeId: string; now: () => Date }): SetStockLevel =>
  async (input) => {
    const level = createStockLevel({
      storeId: deps.storeId,
      sku: input.sku,
      policy: input.policy,
      onHand: input.onHand,
      updatedAt: deps.now(),
    });

    if (!level.ok) return err({ tag: 'invalid', reason: level.error });

    await deps.repository.save(level.value);
    return ok(level.value);
  };

export type AdjustStockError =
  | { readonly tag: 'invalid_delta'; readonly delta: number }
  | { readonly tag: 'failed'; readonly reason: AdjustFailure };

export type AdjustStock = (
  sku: string,
  delta: number,
) => Promise<Result<StockLevel, AdjustStockError>>;

/**
 * Move a SKU's level by a relative amount. This is what a sale uses.
 *
 * Zero is refused rather than accepted as a no-op: a caller asking to move
 * nothing has computed a quantity wrongly, and silently succeeding hides it.
 */
export const makeAdjustStock =
  (deps: { repository: StockRepository; storeId: string; now: () => Date }): AdjustStock =>
  async (sku, delta) => {
    if (!Number.isInteger(delta) || delta === 0) return err({ tag: 'invalid_delta', delta });

    const result = await deps.repository.adjust(deps.storeId, sku, delta, deps.now());
    return result.ok ? ok(result.value) : err({ tag: 'failed', reason: result.error });
  };

/** SKU -> availability, ready for a listing or JSON-LD. */
export const availabilityBySku = (
  skus: readonly string[],
  levels: StockMap,
): ReadonlyMap<string, 'in_stock' | 'out_of_stock'> =>
  new Map(skus.map((sku) => [sku, availabilityOf(levels.get(sku) ?? null)]));
