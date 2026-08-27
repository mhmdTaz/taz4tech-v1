/**
 * Composition root.
 *
 * The one place that knows every dependency and how they fit. No DI framework,
 * no decorators, no reflection — a function that builds the object graph once
 * and hands it out. When wiring is a plain function, "what does this depend on?"
 * is answered by reading forty lines instead of by tracing a container at runtime.
 *
 * Everything above this file receives what it needs. Nothing below it may import
 * this file — the boundary check enforces that, because a module reaching back
 * in here is a service locator wearing a different hat.
 */

import { type CartModule, createCartModule } from '@modules/cart';
import { type CatalogModule, createCatalogModule, type StockWriter } from '@modules/catalog';
import { createInventoryModule, type InventoryModule } from '@modules/inventory';
import { createMediaModule, describeIngestFailure, type MediaModule } from '@modules/media';
import { createOrdersModule, type OrdersModule } from '@modules/orders';
import { createStoreModule, deliveryFeeFor, type StoreModule } from '@modules/store';
import { type Clock, systemClock } from '@platform/clock';
import { type Config, getConfig } from '@platform/config';
import { createFlags, type Flags } from '@platform/flags';
import { createIdGenerator, type IdGenerator } from '@platform/ids';
import { createLogger, type Logger } from '@platform/logger';
import { type Db, getDb } from '@platform/mongo';
import { err, ok } from '@platform/result';

export type Container = {
  readonly config: Config;
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly flags: Flags;
  readonly store: StoreModule;
  readonly catalog: CatalogModule;
  readonly inventory: InventoryModule;
  readonly media: MediaModule;
  readonly cart: CartModule;
  readonly orders: OrdersModule;
};

export const buildContainer = async (): Promise<Container> => {
  const config = getConfig();

  const logger = createLogger({
    level: config.logLevel,
    base: { storeId: config.storeId, env: config.env },
  });

  const db = await getDb({ uri: config.mongo.uri, database: config.mongo.database });

  const clock = systemClock;
  const ids = createIdGenerator(clock.nowMs);
  const flags = createFlags();

  const store = createStoreModule({ db, storeId: config.storeId });
  const inventory = createInventoryModule({
    db,
    storeId: config.storeId,
    now: () => clock.now(),
  });

  const media = createMediaModule({ db, storeId: config.storeId, now: () => clock.now() });

  const catalog = createCatalogModule({
    db,
    storeId: config.storeId,
    now: () => clock.now(),
    nextId: () => ids.next(),
    /*
     * The one place that knows both modules exist.
     *
     * The catalogue's importer needs somewhere to put the spreadsheet's stock
     * column; inventory knows how stock is stored. Neither imports the other —
     * the adapter lives here, which is what a composition root is for.
     */
    /*
     * The catalogue reads image URLs out of a spreadsheet; media knows how to
     * fetch one, check it and store it. Neither imports the other, and the
     * translation from media's error union into one sentence happens here — the
     * catalogue has no business knowing the ways an image can be refused.
     */
    images: {
      take: async (url: string) => {
        const result = await media.ingestImage(url);
        return result.ok
          ? { ok: true as const, path: result.value.path }
          : { ok: false as const, reason: describeIngestFailure(result.error) };
      },
    },
    stock: {
      setLevels: async (levels: Parameters<StockWriter['setLevels']>[0]) => {
        const failures: { sku: string; reason: string }[] = [];
        for (const level of levels) {
          const result = await inventory.setStockLevel({
            sku: level.sku,
            policy: 'tracked',
            onHand: level.onHand,
          });
          if (!result.ok) failures.push({ sku: level.sku, reason: result.error.reason.tag });
        }
        return failures;
      },
    },
  });

  /*
   * Indexes are created HERE, at boot, not by a seed script somebody remembers
   * to run.
   *
   * They were script-only until a fresh database proved what that costs. Without
   * them:
   *
   *   - `$text` search throws "text index required for $text query" — a 500 on
   *     the search box, on a catalogue that has products in it.
   *   - the UNIQUE indexes on (storeId, slug) and (storeId, variants.sku) do not
   *     exist, so two products can hold the same SKU. Every create-vs-update
   *     decision the importer makes, and every conflict the bulk editor reports,
   *     is built on those constraints actually being enforced.
   *
   * The second is the one that matters: it is silent. The site looks fine and
   * the catalogue quietly stops meaning what the code assumes.
   *
   * createIndex is idempotent, so this is a few no-op round trips once per
   * process — getContainer memoises the promise. If it fails, the container
   * fails, the health check fails and the deploy is rejected while the previous
   * version is still serving. That is the correct outcome: an app running
   * without its unique indexes is corrupting data rather than being degraded.
   */
  /*
   * The cart prices against the catalogue and inventory, and stores nothing of
   * its own — it is a cookie. Both dependencies are plain functions rather than
   * module handles, so the cart module cannot reach past the two use cases it
   * actually needs.
   */
  const cart = createCartModule({
    products: (skus) => catalog.getProductsBySkus({ skus }),
    stock: (skus) => inventory.getStockLevels(skus),
    now: () => clock.now(),
  });

  /*
   * Orders sit on top of everything else: they price through the cart, take
   * stock through inventory, and read the delivery fee from store settings.
   * Every one of those arrives as a plain function, so the orders module never
   * holds another module — the wiring is here, where it can be read.
   */
  const orders = createOrdersModule({
    db,
    storeId: config.storeId,
    priceCart: cart.priceCart,
    stock: {
      /*
       * The translation between two vocabularies, written out rather than left
       * to two error unions that happen to overlap.
       *
       * Inventory says "the adjustment failed, and here is why"; an order needs
       * the difference between "nobody counts this, sell it" and "there are not
       * that many", because the first is a sale and the second is a refusal.
       */
      take: async (sku, quantity) => {
        const result = await inventory.adjustStock(sku, -quantity);
        if (result.ok) return ok(undefined);

        if (result.error.tag === 'failed' && result.error.reason.tag === 'insufficient') {
          return err({ tag: 'insufficient' as const, onHand: result.error.reason.onHand });
        }
        if (result.error.tag === 'failed' && result.error.reason.tag === 'untracked') {
          return err({ tag: 'untracked' as const });
        }
        // invalid_delta is a caller bug, not a stock condition, and must not be
        // reported to a customer as "out of stock".
        throw new Error(`Stock could not be taken for ${sku}: ${result.error.tag}`);
      },
      giveBack: async (sku, quantity) => {
        await inventory.adjustStock(sku, quantity);
      },
    },
    deliveryFeeCents: async (region) => {
      const settings = await store.getStoreSettings();
      // No settings document yet means a shop that has not been configured;
      // charging a delivery fee nobody set would be worse than charging none.
      return settings.ok ? deliveryFeeFor(settings.value, region) : 0;
    },
    now: () => clock.now(),
    nextId: () => ids.next(),
  });

  await Promise.all([
    store.ensureIndexes(),
    catalog.ensureIndexes(),
    media.ensureIndexes(),
    inventory.ensureIndexes(),
    orders.ensureIndexes(),
  ]);
  logger.debug('indexes ensured');

  return {
    config,
    db,
    clock,
    ids,
    logger,
    flags,
    store,
    catalog,
    media,
    inventory,
    cart,
    orders,
  };
};

/**
 * Memoised per process. Next runs route handlers and Server Components across
 * many invocations in one process; rebuilding the graph per request would open a
 * connection pool per request.
 *
 * The promise itself is cached, not the resolved value — two concurrent requests
 * during a cold start would otherwise both begin connecting, and the second pool
 * would leak with nothing holding a reference to close it.
 */
let containerPromise: Promise<Container> | null = null;

export const getContainer = async (): Promise<Container> => {
  containerPromise ??= buildContainer();
  try {
    return await containerPromise;
  } catch (error) {
    // A failed boot must not be cached, or every later request inherits a
    // failure caused by a transient DNS or Atlas blip at start-up.
    containerPromise = null;
    throw error;
  }
};

/** Test seam: forget the container so the next call rebuilds it. */
export const resetContainer = (): void => {
  containerPromise = null;
};
