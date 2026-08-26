/**
 * Structured logging.
 *
 * One line of JSON per event, because Render ships stdout to a log search that
 * can only filter on fields it can parse. Human-formatted logs are unsearchable
 * the moment you actually need them.
 *
 * PII: the phone number IS the customer identity in this system — order lookup,
 * history, loyalty and referrals all key on it. That makes it the single most
 * sensitive field in the database, and it must never land in a log line in the
 * clear. Redaction is the default and has to be opted out of explicitly, because
 * the opposite default fails silently and permanently.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that stamps these fields onto every subsequent line. */
  child(fields: LogFields): Logger;
}

/** Field names whose values are replaced before serialisation. */
const REDACTED_KEYS = new Set([
  'phone',
  'phonenumber',
  'msisdn',
  'otp',
  'otpcode',
  'code',
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'mongodb_uri',
  'connectionstring',
  'email',
  'address',
  'addressline',
  'street',
]);

/** Keep the last two digits so a support agent can still match a line to a caller. */
const maskPhone = (value: string): string => (value.length <= 2 ? '***' : `***${value.slice(-2)}`);

const redact = (value: unknown, key = '', depth = 0): unknown => {
  if (depth > 6) return '[depth-limit]';
  if (REDACTED_KEYS.has(key.toLowerCase())) {
    return typeof value === 'string' ? maskPhone(value) : '[redacted]';
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, key, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k, depth + 1);
    return out;
  }
  return value;
};

export type LoggerOptions = {
  readonly level?: LogLevel;
  readonly base?: LogFields;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
};

export const createLogger = (options: LoggerOptions = {}): Logger => {
  const level = options.level ?? 'info';
  const base = options.base ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const threshold = SEVERITY[level];

  const emit = (lineLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (SEVERITY[lineLevel] < threshold) return;
    const payload = {
      level: lineLevel,
      time: now().toISOString(),
      msg: message,
      ...(redact({ ...base, ...fields }) as LogFields),
    };
    write(JSON.stringify(payload));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) =>
      createLogger({
        ...options,
        level,
        base: { ...base, ...fields },
      }),
  };
};

/** Discards everything. For tests that do not assert on logging. */
export const silentLogger: Logger = createLogger({ level: 'error', write: () => {} });
