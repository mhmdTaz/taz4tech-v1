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

/**
 * An optional secret, where BLANK means absent.
 *
 * Render writes an empty string for a `sync: false` variable the operator has
 * not filled in yet. Without this, declaring the admin variables in render.yaml
 * would stop the whole site from booting until a password was typed — an empty
 * secret has to read as "no admin area", not as a fatal misconfiguration.
 */
const optionalSecret = (minimum: number, name: string) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    z.string().min(minimum, `${name} must be at least ${minimum} characters`).optional(),
  );

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

  /**
   * Admin area credentials. BOTH optional, and both must be set together.
   *
   * Absent, the admin area does not exist — every /admin URL is a 404. That is
   * the safe default and it is why these are not required: a deploy that forgets
   * them serves the storefront with no admin, rather than serving an admin with
   * no password.
   *
   * The lengths are enforced here rather than trusted to whoever set them. A
   * short session secret makes the token forgeable, which would let an attacker
   * mint a valid admin session without ever seeing the password.
   */
  ADMIN_PASSWORD: optionalSecret(12, 'ADMIN_PASSWORD'),
  ADMIN_SESSION_SECRET: optionalSecret(32, 'ADMIN_SESSION_SECRET'),

  /**
   * Cloudflare R2, for product photographs. All four together or none.
   *
   * Absent, images are stored in MongoDB, which is where they have always been
   * and is a perfectly good answer for a catalogue this size — see
   * mongo-image-repository.ts. These exist so moving is a deploy rather than a
   * rewrite.
   */
  R2_ACCOUNT_ID: optionalSecret(1, 'R2_ACCOUNT_ID'),
  R2_BUCKET: optionalSecret(1, 'R2_BUCKET'),
  R2_ACCESS_KEY_ID: optionalSecret(1, 'R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: optionalSecret(1, 'R2_SECRET_ACCESS_KEY'),
});

export type Env = z.infer<typeof EnvSchema>;

/** Present only when the admin area is configured; null disables it entirely. */
export type AdminConfig = {
  readonly password: string;
  readonly sessionSecret: string;
};

/** Present only when all four R2 variables are set; null keeps images in Mongo. */
export type R2Config = {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

export type Config = {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly mongo: { readonly uri: string; readonly database: string };
  readonly storeId: string;
  readonly siteUrl: string;
  readonly logLevel: Env['LOG_LEVEL'];
  readonly admin: AdminConfig | null;
  readonly r2: R2Config | null;
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

  /*
   * Half-configured is a configuration error, not a half-open door.
   *
   * Treating one-of-two as "admin off" would silently ignore a password the
   * operator believed they had set; treating it as "admin on" would run the
   * session signer with no secret. Refusing to boot is the only reading that
   * cannot be wrong.
   */
  const { ADMIN_PASSWORD, ADMIN_SESSION_SECRET } = env;
  if ((ADMIN_PASSWORD === undefined) !== (ADMIN_SESSION_SECRET === undefined)) {
    throw new ConfigError([
      'ADMIN_PASSWORD and ADMIN_SESSION_SECRET must be set together, or neither ' +
        '(which disables the admin area).',
    ]);
  }

  /*
   * Same rule as the admin pair, and it matters more here.
   *
   * Three of four set would mean a shop that boots, serves, and stores its
   * photographs somewhere nobody intended — or fails on the first upload, at
   * whatever hour somebody is importing a catalogue. There is no useful reading
   * of a partial object store.
   */
  const r2Fields = [
    ['R2_ACCOUNT_ID', env.R2_ACCOUNT_ID],
    ['R2_BUCKET', env.R2_BUCKET],
    ['R2_ACCESS_KEY_ID', env.R2_ACCESS_KEY_ID],
    ['R2_SECRET_ACCESS_KEY', env.R2_SECRET_ACCESS_KEY],
  ] as const;

  const missing = r2Fields.filter(([, value]) => value === undefined);
  if (missing.length > 0 && missing.length < r2Fields.length) {
    throw new ConfigError([
      `R2 is half-configured. Set all four or none; missing: ${missing
        .map(([name]) => name)
        .join(', ')}.`,
    ]);
  }

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    mongo: { uri: env.MONGODB_URI, database: env.MONGODB_DB },
    storeId: env.STORE_ID,
    siteUrl: env.SITE_URL.replace(/\/+$/, ''),
    logLevel: env.LOG_LEVEL,
    admin:
      ADMIN_PASSWORD === undefined || ADMIN_SESSION_SECRET === undefined
        ? null
        : { password: ADMIN_PASSWORD, sessionSecret: ADMIN_SESSION_SECRET },
    r2:
      env.R2_ACCOUNT_ID === undefined ||
      env.R2_BUCKET === undefined ||
      env.R2_ACCESS_KEY_ID === undefined ||
      env.R2_SECRET_ACCESS_KEY === undefined
        ? null
        : {
            accountId: env.R2_ACCOUNT_ID,
            bucket: env.R2_BUCKET,
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          },
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
