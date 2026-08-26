/**
 * Configuration — parsed and validated once, at process start.
 *
 * Every environment value passes through Zod here and nowhere else. Reading
 * process.env anywhere below this file is a boundary violation: it hides a
 * required variable from the startup check, so the app boots fine and then dies
 * on the first order at 11pm.
 *
 * Failure reports EVERY missing or malformed variable at once. Discovering them
 * one deploy at a time is how a 5-minute config fix becomes an hour.
 */

import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Atlas connection string. Provided by Render; never committed. */
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB: z.string().min(1).default('taz4tech'),

  /**
   * Tenant discriminator. Single store today, but every document carries it and
   * every repository filters on it, so a second store is configuration rather
   * than a migration.
   */
  STORE_ID: z.string().min(1).default('taz4tech'),

  /** Canonical origin, no trailing slash. Used for sitemaps, hreflang, JSON-LD. */
  SITE_URL: z.url().default('https://taz4tech.com'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export type Config = {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly mongo: { readonly uri: string; readonly database: string };
  readonly storeId: string;
  readonly siteUrl: string;
  readonly logLevel: Env['LOG_LEVEL'];
};

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Parse an arbitrary record. Exported separately so tests never touch process.env. */
export const parseConfig = (source: Record<string, string | undefined>): Config => {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const env = parsed.data;
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    mongo: { uri: env.MONGODB_URI, database: env.MONGODB_DB },
    storeId: env.STORE_ID,
    siteUrl: env.SITE_URL.replace(/\/+$/, ''),
    logLevel: env.LOG_LEVEL,
  };
};

let cached: Config | null = null;

/** The process-wide config. Throws once, loudly, on the first call if invalid. */
export const getConfig = (): Config => {
  cached ??= parseConfig(process.env);
  return cached;
};

/** Test seam: drop the memoised config. */
export const resetConfig = (): void => {
  cached = null;
};
