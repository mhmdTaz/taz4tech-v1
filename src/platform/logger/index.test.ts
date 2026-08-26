import { describe, expect, it } from 'vitest';
import { createLogger, silentLogger } from './index';

const capture = (level?: 'debug' | 'info' | 'warn' | 'error') => {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    ...(level === undefined ? {} : { level }),
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => new Date('2026-08-26T10:00:00Z'),
  });
  return { logger, lines };
};

describe('createLogger', () => {
  it('emits one JSON object per line with level, time and message', () => {
    const { logger, lines } = capture();
    logger.info('order placed', { orderNumber: 'T4T-26-000042' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      time: '2026-08-26T10:00:00.000Z',
      msg: 'order placed',
      orderNumber: 'T4T-26-000042',
    });
  });

  it('drops lines below the configured level', () => {
    const { logger, lines } = capture('warn');
    logger.debug('noisy');
    logger.info('also noisy');
    logger.warn('kept');
    logger.error('kept too');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('defaults to info, so debug is off in production without configuration', () => {
    const { logger, lines } = capture();
    logger.debug('hidden');
    expect(lines).toHaveLength(0);
  });
});

describe('redaction', () => {
  it('masks a phone number, keeping the last two digits for support', () => {
    const { logger, lines } = capture();
    logger.info('otp sent', { phone: '+96170123456' });
    expect(lines[0]?.phone).toBe('***56');
    expect(JSON.stringify(lines[0])).not.toContain('70123456');
  });

  it('masks the OTP code itself', () => {
    const { logger, lines } = capture();
    logger.info('otp generated', { otp: '481920' });
    expect(lines[0]?.otp).toBe('***20');
  });

  it('redacts nested PII, not only top-level fields', () => {
    const { logger, lines } = capture();
    logger.info('order', { customer: { name: 'Sara', phone: '+9613111222', email: 'a@b.co' } });
    const customer = lines[0]?.customer as Record<string, unknown>;
    expect(customer.name).toBe('Sara');
    expect(customer.phone).toBe('***22');
    expect(customer.email).toBe('***co');
  });

  it('redacts inside arrays', () => {
    const { logger, lines } = capture();
    logger.info('bulk', { recipients: [{ phone: '+9613111222' }, { phone: '+9613999888' }] });
    const recipients = lines[0]?.recipients as Record<string, unknown>[];
    expect(recipients.map((r) => r.phone)).toEqual(['***22', '***88']);
  });

  it('redacts a connection string so it can never reach a log aggregator', () => {
    const { logger, lines } = capture();
    logger.error('boot failed', { MONGODB_URI: 'mongodb+srv://user:pw@cluster/db' });
    expect(JSON.stringify(lines[0])).not.toContain('pw@cluster');
  });

  it('replaces a non-string secret wholesale rather than masking it', () => {
    const { logger, lines } = capture();
    logger.info('weird', { token: { a: 1 } });
    expect(lines[0]?.token).toBe('[redacted]');
  });

  it('masks a very short value completely', () => {
    const { logger, lines } = capture();
    logger.info('short', { phone: '7' });
    expect(lines[0]?.phone).toBe('***');
  });

  it('serialises an Error without losing its message', () => {
    const { logger, lines } = capture();
    logger.error('failed', { cause: new Error('atlas unreachable') });
    expect(lines[0]?.cause).toMatchObject({ name: 'Error', message: 'atlas unreachable' });
  });

  it('stops at a depth limit instead of recursing forever on a cyclic object', () => {
    const { logger, lines } = capture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => logger.info('cyclic', { cyclic })).not.toThrow();
    expect(JSON.stringify(lines[0])).toContain('depth-limit');
  });
});

describe('child loggers', () => {
  it('stamps base fields onto every line', () => {
    const { logger, lines } = capture();
    const scoped = logger.child({ requestId: 'r-1' });
    scoped.info('one');
    scoped.info('two');
    expect(lines.every((l) => l.requestId === 'r-1')).toBe(true);
  });

  it('merges rather than replaces when nested', () => {
    const { logger, lines } = capture();
    logger.child({ a: 1 }).child({ b: 2 }).info('deep');
    expect(lines[0]).toMatchObject({ a: 1, b: 2 });
  });

  it('lets a per-call field override a base field', () => {
    const { logger, lines } = capture();
    logger.child({ stage: 'boot' }).info('later', { stage: 'ready' });
    expect(lines[0]?.stage).toBe('ready');
  });
});

describe('the default writer', () => {
  it('writes a newline-terminated JSON line to stdout', () => {
    // Every other test injects a writer, which would leave the real one — the
    // one production actually uses — completely unexercised.
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      createLogger().info('through stdout', { orderNumber: 'T4T-26-000001' });
    } finally {
      process.stdout.write = original;
    }

    expect(written).toHaveLength(1);
    // Newline-terminated, so a log collector reading the stream line by line
    // does not merge two events into one unparsable record.
    expect(written[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(written[0] ?? '{}')).toMatchObject({
      level: 'info',
      msg: 'through stdout',
      orderNumber: 'T4T-26-000001',
    });
  });
});

describe('silentLogger', () => {
  it('writes nothing at any level', () => {
    expect(() => {
      silentLogger.debug('a');
      silentLogger.info('b');
      silentLogger.warn('c');
      silentLogger.error('d');
    }).not.toThrow();
  });
});
