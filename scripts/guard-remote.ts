/**
 * Refuse to write to a database that is not on this machine.
 *
 * Two scripts here can ruin a real shop in one command. `pnpm seed:demo` writes
 * three fake laptops and a cable, three of them ACTIVE, so on a production
 * catalogue that is four products a customer can buy. `pnpm seed --reset`
 * replaces the settings document, discarding the shop's name, phone number, VAT
 * rate and eight delivery prices.
 *
 * Neither is a far-fetched mistake, and the shape of it is specific. These
 * scripts do NOT read `.env.local`; `MONGODB_URI` has to be in the environment,
 * which is exactly what an operator does to run `pnpm seed` against Atlas the
 * one time a real store is created. From then on every command in that shell
 * inherits it, and `pnpm seed:demo` is the next thing anyone types when the
 * storefront looks empty. Nothing else would have caught it: the write succeeds,
 * reports success, and the fixtures are live.
 *
 * THE OVERRIDE NAMES THE DATABASE
 * -------------------------------
 * A plain `--force` would be typed from muscle memory, and a command recalled
 * from shell history would carry it. Requiring the database name means the
 * override only works for the database it was written for: recall it against a
 * different one and it refuses again, which is exactly when it should.
 */

import { isLocalMongo, mongoHosts } from '../src/platform/mongo/index.js';

export const TARGET_ENV = 'TAZ_SEED_TARGET';

export type RemoteGuard = {
  readonly uri: string;
  readonly database: string;
  /** What the script would do, in the operator's words: "write demo fixtures". */
  readonly action: string;
  readonly command: string;
};

/**
 * Allowed, or a refusal to print. Pure, so the caller decides how to exit.
 *
 * Returns null when the write may proceed.
 */
export const remoteRefusal = (guard: RemoteGuard): string | null => {
  if (isLocalMongo(guard.uri)) return null;
  if (process.env[TARGET_ENV] === guard.database) return null;

  const hosts = mongoHosts(guard.uri);
  const where = hosts.length > 0 ? hosts.join(', ') : '(unreadable connection string)';

  return [
    `Refusing to ${guard.action}: "${guard.database}" is not a local database.`,
    '',
    `  host      ${where}`,
    `  database  ${guard.database}`,
    '',
    'If that really is the database you meant, name it and run again:',
    '',
    `  ${TARGET_ENV}=${guard.database} ${guard.command}`,
  ].join('\n');
};
