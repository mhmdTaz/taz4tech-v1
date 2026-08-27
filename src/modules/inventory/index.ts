/**
 * Public surface of the inventory module.
 *
 * Stock is separate from the catalogue on purpose — see the note at the top of
 * domain/stock.ts. Everything the rest of the system may know about it is on
 * this page; the boundary check rejects any import that reaches past it.
 */

import type { Db } from '@platform/mongo';
import {
  type AdjustStock,
  type GetStockLevels,
  makeAdjustStock,
  makeGetStockLevels,
  makeSetStockLevel,
  type SetStockLevel,
} from './application/stock-levels';
import {
  createMongoStockRepository,
  ensureStockIndexes,
} from './infrastructure/mongo-stock-repository';

export type {
  AdjustStock,
  AdjustStockError,
  GetStockLevels,
  SetStockLevel,
  SetStockLevelError,
  SetStockLevelInput,
  StockMap,
} from './application/stock-levels';
export { availabilityBySku, MAX_SKU_LOOKUP } from './application/stock-levels';
export type { AdjustFailure, StockRepository } from './contracts';
export type { Availability, StockError, StockLevel, StockPolicy } from './domain/stock';
export {
  availabilityOf,
  canTake,
  countToShow,
  createStockLevel,
  MAX_ON_HAND,
} from './domain/stock';

export type InventoryModule = {
  readonly getStockLevels: GetStockLevels;
  readonly setStockLevel: SetStockLevel;
  readonly adjustStock: AdjustStock;
  readonly ensureIndexes: () => Promise<void>;
};

export const createInventoryModule = (deps: {
  db: Db;
  storeId: string;
  now: () => Date;
}): InventoryModule => {
  const repository = createMongoStockRepository(deps.db);
  const wiring = { repository, storeId: deps.storeId };

  return {
    getStockLevels: makeGetStockLevels(wiring),
    setStockLevel: makeSetStockLevel({ ...wiring, now: deps.now }),
    adjustStock: makeAdjustStock({ ...wiring, now: deps.now }),
    ensureIndexes: () => ensureStockIndexes(deps.db),
  };
};
