/**
 * MongoDB client lifecycle.
 *
 * The only place outside a module's infrastructure/ folder allowed to import the
 * driver. It knows how to open a connection; it knows nothing about products,
 * orders or carriers.
 *
 * The client is cached on globalThis because Next dev reloads this module on
 * every edit. Without the cache each save opens a fresh pool and Atlas hits its
 * connection cap within a few minutes of work — a classic Next + Mongo failure
 * that only shows up after twenty saves, never on the first run.
 */

import { type Db, MongoClient } from 'mongodb';

/**
 * Driver types are re-exported here so that a module barrel or the composition
 * root can name a Db without importing the driver itself. The boundary rule that
 * confines `mongodb` to infrastructure/ then stays absolute, with no
 * type-only exemption to argue about later.
 */
export type { ClientSession, Collection, Db, MongoClient } from 'mongodb';

/** Reading a connection string without opening one. See uri.ts for why. */
export { isLocalMongo, mongoHosts } from './uri';

export type MongoOptions = {
  readonly uri: string;
  readonly database: string;
  /** Atlas M0/M2 have low connection caps; Render runs few instances. 10 is plenty. */
  readonly maxPoolSize?: number;
};

type Cache = { client: MongoClient | null; promise: Promise<MongoClient> | null };

const globalCache = globalThis as unknown as { __taz4techMongo?: Cache };
const cache: Cache = globalCache.__taz4techMongo ?? { client: null, promise: null };
globalCache.__taz4techMongo = cache;

export const getMongoClient = async (options: MongoOptions): Promise<MongoClient> => {
  if (cache.client !== null) return cache.client;

  if (cache.promise === null) {
    cache.promise = new MongoClient(options.uri, {
      maxPoolSize: options.maxPoolSize ?? 10,
      retryWrites: true,
      // Fail fast rather than hanging a checkout request for 30 seconds.
      serverSelectionTimeoutMS: 5_000,
    }).connect();
  }

  cache.client = await cache.promise;
  return cache.client;
};

export const getDb = async (options: MongoOptions): Promise<Db> =>
  (await getMongoClient(options)).db(options.database);

export const closeMongo = async (): Promise<void> => {
  if (cache.client !== null) await cache.client.close();
  cache.client = null;
  cache.promise = null;
};
