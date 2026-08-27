/**
 * Stock in MongoDB.
 *
 * THE _id IS THE NATURAL KEY
 * --------------------------
 * (storeId, sku) identifies a level, so it IS the document id rather than being
 * a unique index over a surrogate one. That buys two things: one index instead
 * of two, and — the reason that matters — an upsert that cannot race. Upserting
 * on a filter can throw a duplicate key when two writers arrive together, which
 * is a documented MongoDB behaviour and a retry loop nobody wants to own.
 *
 * The id is LENGTH-PREFIXED: `8:taz4tech:SKU-1`. A plain `storeId:sku` join is
 * ambiguous the moment a SKU contains the separator — store "a" with SKU "b:c"
 * and store "a:b" with SKU "c" would be the same document, in different
 * tenants. SKUs come from other people's spreadsheets; they contain anything.
 */

import { err, ok, type Result } from '@platform/result';
import type { Collection, Db } from 'mongodb';
import { z } from 'zod';
import type { AdjustFailure, StockRepository } from '../contracts';
import type { StockLevel, StockPolicy } from '../domain/stock';

export const STOCK_COLLECTION = 'stock';

const STOCK_POLICIES = ['tracked', 'untracked'] as const;

type StockDocument = {
  _id: string;
  storeId: string;
  sku: string;
  policy: StockPolicy;
  onHand: number;
  updatedAt: Date;
};

/**
 * Length-prefixed so the pair can never be read two ways. See the note above.
 */
export const stockId = (storeId: string, sku: string): string =>
  `${storeId.length}:${storeId}:${sku}`;

const DocumentSchema = z.object({
  _id: z.string(),
  storeId: z.string().min(1),
  sku: z.string().min(1),
  policy: z.enum(STOCK_POLICIES),
  onHand: z.number().int().min(0),
  updatedAt: z.date(),
});

/**
 * Parsed on the way OUT, not trusted.
 *
 * A document written by an older version of this code, or by a hand-run
 * mongosh command during an incident, is exactly the input that turns into a
 * negative price or a NaN quantity three layers up. Failing here names the
 * document instead.
 */
const toDomain = (document: unknown): StockLevel => {
  const parsed = DocumentSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`Unreadable stock document: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const { storeId, sku, policy, onHand, updatedAt } = parsed.data;
  return { storeId, sku, policy, onHand, updatedAt };
};

const toDocument = (level: StockLevel): StockDocument => ({
  _id: stockId(level.storeId, level.sku),
  storeId: level.storeId,
  sku: level.sku,
  policy: level.policy,
  onHand: level.onHand,
  updatedAt: level.updatedAt,
});

export const createMongoStockRepository = (db: Db): StockRepository => {
  const collection: Collection<StockDocument> = db.collection(STOCK_COLLECTION);

  const read = async (storeId: string, sku: string): Promise<StockLevel | null> => {
    const document = await collection.findOne({ _id: stockId(storeId, sku), storeId });
    return document === null ? null : toDomain(document);
  };

  return {
    findBySku: read,

    async findBySkus(storeId, skus) {
      if (skus.length === 0) return [];
      const ids = skus.map((sku) => stockId(storeId, sku));
      // By _id, so this is an IXSCAN on the primary key by construction.
      const documents = await collection.find({ _id: { $in: ids }, storeId }).toArray();
      return documents.map(toDomain);
    },

    async save(level) {
      const document = toDocument(level);
      await collection.replaceOne({ _id: document._id }, document, { upsert: true });
    },

    async adjust(storeId, sku, delta, now): Promise<Result<StockLevel, AdjustFailure>> {
      const _id = stockId(storeId, sku);

      /*
       * The condition IS the concurrency control.
       *
       * For a decrement the filter demands the units are there; MongoDB applies
       * the match and the $inc as one operation on one document, so two orders
       * for the last unit cannot both match. Checking in the application layer
       * and then writing re-opens exactly the window this closes.
       */
      const guard =
        delta < 0
          ? { _id, storeId, policy: 'tracked' as const, onHand: { $gte: -delta } }
          : { _id, storeId, policy: 'tracked' as const };

      const updated = await collection.findOneAndUpdate(
        guard,
        { $inc: { onHand: delta }, $set: { updatedAt: now } },
        { returnDocument: 'after' },
      );

      if (updated !== null) return ok(toDomain(updated));

      /*
       * The update matched nothing, and WHY matters to the caller: an untracked
       * SKU sells freely while an exhausted one must not. One extra read, only
       * on the path that already failed, to answer that precisely rather than
       * collapsing both into "no".
       */
      const level = await read(storeId, sku);
      if (level === null || level.policy === 'untracked') return err({ tag: 'untracked', sku });

      return err({ tag: 'insufficient', sku, onHand: level.onHand });
    },
  };
};

/** Called once at startup. Idempotent — createIndex is a no-op if it already exists. */
export const ensureStockIndexes = async (db: Db): Promise<void> => {
  const collection = db.collection(STOCK_COLLECTION);
  /*
   * No index on (storeId, sku): that pair IS the _id, which is indexed already.
   * This one serves the admin's "what is tracked, and what has run out" view,
   * which is the only query that is not a primary-key lookup.
   */
  await collection.createIndex(
    { storeId: 1, policy: 1, onHand: 1 },
    { name: 'storeId_policy_onHand' },
  );
};
