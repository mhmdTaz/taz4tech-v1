import { afterEach, describe, expect, it } from 'vitest';
import { onRequestError } from './instrumentation';

/**
 * The reporter is the only thing standing between a 500 at eleven at night and
 * nobody finding out, and until this file it had no test at all — it was
 * verified once, by hand, with a route that threw on purpose and has since been
 * deleted.
 */

type Request = Parameters<typeof onRequestError>[1];
type Context = Parameters<typeof onRequestError>[2];

const request = { path: '/en/products/anker-cable', method: 'GET', headers: {} } as Request;

const context = {
  routerKind: 'App Router',
  routePath: '/[locale]/products/[slug]',
  routeType: 'render',
} as Context;

/** Everything written to stdout while `run` was awaited, one entry per line. */
const captureStdout = async (run: () => Promise<void>): Promise<string[]> => {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    await run();
  } finally {
    process.stdout.write = original;
  }

  return written;
};

const previousRuntime = process.env.NEXT_RUNTIME;

afterEach(() => {
  if (previousRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = previousRuntime;
});

describe('on the server, where there is a stdout to write to', () => {
  it('writes one JSON line naming the error and the route', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    const written = await captureStdout(async () => {
      await onRequestError(new Error('the database went away'), request, context);
    });

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? '{}')).toMatchObject({
      level: 'error',
      source: 'onRequestError',
      msg: 'unhandled server error',
      name: 'Error',
      reason: 'the database went away',
      path: '/en/products/anker-cable',
      method: 'GET',
      routeType: 'render',
    });
  });

  it('reports something thrown that is not an Error', async () => {
    // `throw 'nope'` is legal and happens in library code. Losing the report
    // because the thing thrown had no .message would lose the error entirely.
    process.env.NEXT_RUNTIME = 'nodejs';

    const written = await captureStdout(async () => {
      await onRequestError('just a string', request, context);
    });

    expect(JSON.parse(written[0] ?? '{}')).toMatchObject({
      name: 'unknown',
      reason: 'just a string',
    });
  });

  it('does not serialise the error object whole', async () => {
    /*
     * A thrown Mongo error carries the connection string as a property. Logging
     * the object would put the password into the log this exists to make
     * readable — so only named fields are taken, and this is the test that says
     * so rather than the comment.
     */
    process.env.NEXT_RUNTIME = 'nodejs';
    const error = Object.assign(new Error('connection failed'), {
      connectionString: 'mongodb+srv://user:hunter2@cluster.example.net',
    });

    const written = await captureStdout(async () => {
      await onRequestError(error, request, context);
    });

    expect(written[0]).not.toContain('hunter2');
    expect(written[0]).toContain('connection failed');
  });
});

describe('on the edge, where there is not', () => {
  it('writes nothing rather than reaching for a stdout that is not there', async () => {
    /*
     * `src/proxy.ts` makes Next compile instrumentation for the Edge runtime as
     * well. Importing the logger at module scope put `process.stdout` into that
     * bundle, and every request logged a compile failure for it — which is a
     * reporter that reports on itself instead of on the shop.
     */
    process.env.NEXT_RUNTIME = 'edge';

    const written = await captureStdout(async () => {
      await onRequestError(new Error('boom'), request, context);
    });

    expect(written).toEqual([]);
  });
});
