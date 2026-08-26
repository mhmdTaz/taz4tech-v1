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
