/**
 * Ports for stock. Infrastructure implements these; the application layer
 * depends only on them.
 */

import type { Result } from '@platform/result';
import type { StockLevel } from '../domain/stock';

export type AdjustFailure =
  /**
   * Nothing to adjust: no record, or a SKU deliberately not counted.
   *
   * NOT an error for a sale — an untracked SKU sells freely, which is what
   * untracked means. It is the caller's job to decide, and orders will treat
   * this as success.
   */
  | { readonly tag: 'untracked'; readonly sku: string }
  /** Tracked, counted, and there are not that many. */
  | { readonly tag: 'insufficient'; readonly sku: string; readonly onHand: number };

export interface StockRepository {
  findBySku(storeId: string, sku: string): Promise<StockLevel | null>;
  /**
   * Bulk lookup, for a listing.
   *
   * One query for a page of products rather than one per variant. Absent SKUs
   * are simply missing from the result — the caller reads that as untracked,
   * which is the domain's rule, not this port's.
   */
  findBySkus(storeId: string, skus: readonly string[]): Promise<StockLevel[]>;
  save(level: StockLevel): Promise<void>;
  /**
   * Change the count by delta, atomically, refusing to go below zero.
   *
   * This is the whole reason stock is its own document. A decrement is a single
   * conditional update — "subtract 1 where at least 1 remains" — so two orders
   * for the last unit cannot both succeed. Read the level, decide, then write
   * and the race is back, whatever the application layer does in between.
   */
  adjust(
    storeId: string,
    sku: string,
    delta: number,
    now: Date,
  ): Promise<Result<StockLevel, AdjustFailure>>;
}
