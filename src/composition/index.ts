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

import { type CatalogModule, createCatalogModule } from '@modules/catalog';
import { createStoreModule, type StoreModule } from '@modules/store';
import { type Clock, systemClock } from '@platform/clock';
import { type Config, getConfig } from '@platform/config';
import { createFlags, type Flags } from '@platform/flags';
import { createIdGenerator, type IdGenerator } from '@platform/ids';
import { createLogger, type Logger } from '@platform/logger';
import { type Db, getDb } from '@platform/mongo';

export type Container = {
  readonly config: Config;
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly flags: Flags;
  readonly store: StoreModule;
  readonly catalog: CatalogModule;
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
  const catalog = createCatalogModule({
    db,
    storeId: config.storeId,
    now: () => clock.now(),
    nextId: () => ids.next(),
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
  await Promise.all([store.ensureIndexes(), catalog.ensureIndexes()]);
  logger.debug('indexes ensured');

  return { config, db, clock, ids, logger, flags, store, catalog };
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
