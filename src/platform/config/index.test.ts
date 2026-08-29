import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, getConfig, parseConfig, resetConfig } from './index';

const valid = {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb+srv://user:pw@cluster.mongodb.net',
  MONGODB_DB: 'taz4tech',
  STORE_ID: 'taz4tech',
  SITE_URL: 'https://taz4tech.com',
  LOG_LEVEL: 'info',
};

describe('parseConfig', () => {
  it('reads a complete environment', () => {
    const config = parseConfig(valid);
    expect(config.env).toBe('production');
    expect(config.isProduction).toBe(true);
    expect(config.mongo).toEqual({ uri: valid.MONGODB_URI, database: 'taz4tech' });
    expect(config.storeId).toBe('taz4tech');
    expect(config.siteUrl).toBe('https://taz4tech.com');
    expect(config.logLevel).toBe('info');
  });

  it('applies defaults for everything except the connection string', () => {
    const config = parseConfig({ MONGODB_URI: valid.MONGODB_URI });
    expect(config.env).toBe('development');
    expect(config.isProduction).toBe(false);
    expect(config.mongo.database).toBe('taz4tech');
    expect(config.storeId).toBe('taz4tech');
    expect(config.siteUrl).toBe('https://taz4tech.com');
    expect(config.logLevel).toBe('info');
  });

  it('strips a trailing slash so canonical URLs never double up', () => {
    expect(parseConfig({ ...valid, SITE_URL: 'https://taz4tech.com/' }).siteUrl).toBe(
      'https://taz4tech.com',
    );
    expect(parseConfig({ ...valid, SITE_URL: 'https://taz4tech.com///' }).siteUrl).toBe(
      'https://taz4tech.com',
    );
  });

  it('fails when the connection string is missing', () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
  });

  it('reports EVERY problem at once, not one deploy at a time', () => {
    let issues: readonly string[] = [];
    try {
      parseConfig({ NODE_ENV: 'staging', SITE_URL: 'not-a-url', LOG_LEVEL: 'verbose' });
    } catch (error) {
      if (error instanceof ConfigError) issues = error.issues;
    }
    // MONGODB_URI missing, NODE_ENV invalid, SITE_URL invalid, LOG_LEVEL invalid.
    expect(issues.length).toBeGreaterThanOrEqual(4);
    expect(issues.join('\n')).toContain('MONGODB_URI');
    expect(issues.join('\n')).toContain('NODE_ENV');
    expect(issues.join('\n')).toContain('SITE_URL');
    expect(issues.join('\n')).toContain('LOG_LEVEL');
  });

  it('names the offending variable in the message', () => {
    expect(() => parseConfig({ ...valid, SITE_URL: 'nope' })).toThrow(/SITE_URL/);
  });

  it('rejects an empty connection string as firmly as a missing one', () => {
    expect(() => parseConfig({ ...valid, MONGODB_URI: '' })).toThrow(ConfigError);
  });

  it('rejects an empty store id, which would break tenant isolation silently', () => {
    expect(() => parseConfig({ ...valid, STORE_ID: '' })).toThrow(ConfigError);
  });

  it('labels a root-level problem when the source is not an object at all', () => {
    // Guards the '(root)' fallback: a Zod issue with an empty path would
    // otherwise render as ": Invalid input" with nothing naming the problem.
    try {
      parseConfig(null as unknown as Record<string, string>);
      throw new Error('expected parseConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join(' | ')).toContain('(root)');
    }
  });

  it('carries the ConfigError name for log filtering', () => {
    try {
      parseConfig({});
    } catch (error) {
      expect((error as Error).name).toBe('ConfigError');
    }
  });
});

describe('admin credentials', () => {
  const PASSWORD = 'a-long-enough-password';
  const SECRET = 'x'.repeat(32);

  it('leaves the admin area disabled when neither is set', () => {
    // The safe default, and the one a fresh deploy gets. Disabled means the
    // routes 404 — not that they exist without a password.
    expect(parseConfig(valid).admin).toBeNull();
  });

  it('enables the admin area when both are set', () => {
    const config = parseConfig({
      ...valid,
      ADMIN_PASSWORD: PASSWORD,
      ADMIN_SESSION_SECRET: SECRET,
    });
    expect(config.admin).toEqual({ password: PASSWORD, sessionSecret: SECRET });
  });

  it.each([
    ['password without secret', { ADMIN_PASSWORD: PASSWORD }],
    ['secret without password', { ADMIN_SESSION_SECRET: SECRET }],
  ])('refuses to boot with a %s', (_label, partial) => {
    // Not "admin off" — that would silently ignore a password the operator
    // believes is protecting the site.
    expect(() => parseConfig({ ...valid, ...partial })).toThrow(ConfigError);
  });

  it.each([
    ['both blank', { ADMIN_PASSWORD: '', ADMIN_SESSION_SECRET: '' }],
    ['blank and whitespace', { ADMIN_PASSWORD: '   ', ADMIN_SESSION_SECRET: '' }],
  ])('treats %s as no admin area rather than as a boot failure', (_label, partial) => {
    // Render writes an empty string for a sync:false variable nobody has filled
    // in. Blank must mean absent, or declaring these in render.yaml would stop
    // the storefront from starting until a password was typed.
    expect(parseConfig({ ...valid, ...partial }).admin).toBeNull();
  });

  it('still refuses a blank password beside a real secret', () => {
    expect(() =>
      parseConfig({ ...valid, ADMIN_PASSWORD: '', ADMIN_SESSION_SECRET: SECRET }),
    ).toThrow(ConfigError);
  });

  it('rejects a session secret short enough to be brute-forced', () => {
    expect(() =>
      parseConfig({ ...valid, ADMIN_PASSWORD: PASSWORD, ADMIN_SESSION_SECRET: 'too-short' }),
    ).toThrow(/ADMIN_SESSION_SECRET/);
  });

  it('rejects a password short enough to be guessed', () => {
    expect(() =>
      parseConfig({ ...valid, ADMIN_PASSWORD: 'short', ADMIN_SESSION_SECRET: SECRET }),
    ).toThrow(/ADMIN_PASSWORD/);
  });
});

describe('getConfig', () => {
  afterEach(() => {
    resetConfig();
    delete process.env.MONGODB_URI;
    delete process.env.STORE_ID;
  });

  it('reads process.env and memoises the result', () => {
    process.env.MONGODB_URI = valid.MONGODB_URI;
    process.env.STORE_ID = 'first';

    const first = getConfig();
    expect(first.storeId).toBe('first');

    // A later mutation of the environment must not change an already-built
    // config: the object graph is wired from it once, at boot.
    process.env.STORE_ID = 'second';
    expect(getConfig().storeId).toBe('first');
    expect(getConfig()).toBe(first);
  });

  it('rebuilds after resetConfig, which is what makes it testable at all', () => {
    process.env.MONGODB_URI = valid.MONGODB_URI;
    process.env.STORE_ID = 'first';
    getConfig();

    resetConfig();
    process.env.STORE_ID = 'second';
    expect(getConfig().storeId).toBe('second');
  });

  it('throws when the process environment is incomplete', () => {
    resetConfig();
    delete process.env.MONGODB_URI;
    expect(() => getConfig()).toThrow(ConfigError);
  });
});

describe('the R2 image store', () => {
  const r2 = {
    R2_ACCOUNT_ID: 'abc123',
    R2_BUCKET: 'taz4tech-media',
    R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  };

  it('is absent by default, which keeps images in Mongo', () => {
    expect(parseConfig(valid).r2).toBeNull();
  });

  it('is read when all four are set', () => {
    expect(parseConfig({ ...valid, ...r2 }).r2).toEqual({
      accountId: 'abc123',
      bucket: 'taz4tech-media',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    });
  });

  it.each(Object.keys(r2))('refuses to boot with %s missing, naming it', (missing) => {
    /*
     * Three of four would be a shop that boots and then stores its photographs
     * somewhere nobody intended, or fails on the first upload at whatever hour
     * somebody is importing a catalogue. There is no useful reading of half an
     * object store, so it is a startup error that says which one is absent.
     */
    const partial = { ...valid, ...r2, [missing]: undefined };

    expect(() => parseConfig(partial)).toThrow(ConfigError);
    expect(() => parseConfig(partial)).toThrow(new RegExp(`missing: ${missing}`));
  });

  it('treats blank as absent, because that is what Render writes', () => {
    // Declaring the variables in render.yaml without filling them in must read
    // as "no R2", not as a boot failure — the same reason the admin pair does.
    const blank = {
      ...valid,
      R2_ACCOUNT_ID: '',
      R2_BUCKET: '',
      R2_ACCESS_KEY_ID: '',
      R2_SECRET_ACCESS_KEY: '',
    };
    expect(parseConfig(blank).r2).toBeNull();
  });
});
