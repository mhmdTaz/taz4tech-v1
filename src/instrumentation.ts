/**
 * Where server errors go.
 *
 * Next calls `onRequestError` for every uncaught error on the server — a page
 * that throws, a Server Action that throws, a route handler that throws. Before
 * this file existed there was nowhere for one to go: the customer saw a generic
 * page, the process wrote whatever Next writes, and nobody found out unless
 * somebody rang up.
 *
 * WHY NOT SENTRY
 * --------------
 * Because a vendor is a decision, an account, a key and a monthly bill, and
 * none of that is needed to stop losing errors. What was missing was not a
 * dashboard — it was a line in the log with enough on it to act. Render already
 * collects stdout, and this makes every server error one greppable JSON object
 * there, at level error, with the route that produced it.
 *
 * If a dashboard is wanted later, this is the one function that has to change.
 *
 * WHAT IS AND IS NOT REDACTED
 * ---------------------------
 * It goes through `platform/logger`, which strips values by FIELD NAME — phone,
 * address, token, connection string. That covers the structured fields below,
 * and it does NOT cover `reason` and `stack`, which are free text: an exception
 * that puts a customer's phone number in its own message would carry it into
 * the log.
 *
 * Named here rather than assumed away, because "it goes through the redacting
 * logger" is the sort of sentence that reads like a guarantee and is not one.
 * The error object itself is deliberately not serialised whole — a thrown Mongo
 * error carries the connection string as a property, and JSON.stringify of it
 * would put the password in the log this exists to make readable.
 */

import type { Logger } from '@platform/logger';
import type { Instrumentation } from 'next';

/*
 * TWO RUNTIMES, AND THE LOGGER ONLY WORKS IN ONE
 * ----------------------------------------------
 * This file is compiled for the Node runtime AND for the Edge one, because
 * `src/proxy.ts` exists — Next 16's name for middleware, which runs on Edge.
 * The logger writes with `process.stdout`, which Edge does not have, so
 * importing it at the top of this file put a Node API into the Edge bundle:
 * a warning and a failed compile of the Edge instrumentation on every single
 * request, which is how it was noticed.
 *
 * `process.env.NEXT_RUNTIME` is replaced with a literal per bundle, so the
 * import below is dropped entirely from the Edge one rather than being loaded
 * and failing. The type import is erased at compile time and costs nothing.
 *
 * WHAT THIS GIVES UP: an uncaught error inside `proxy.ts` is not logged here.
 * That file is next-intl's locale routing and nothing else, and the alternative
 * — a second, unredacted log shape written with `console` — is worse than the
 * gap. It is a gap, and it is written down rather than implied.
 */
let logger: Logger | undefined;

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  /*
   * Its own logger, not the container's.
   *
   * getContainer() connects to MongoDB, and the error being reported may BE that
   * the database is unreachable. An error reporter that needs the thing that
   * broke reports nothing at the moment it matters most.
   *
   * Built once and kept, so a burst of errors does not build one each time.
   */
  if (logger === undefined) {
    const { createLogger } = await import('@platform/logger');
    logger = createLogger({ level: 'error', base: { source: 'onRequestError' } });
  }

  const cause = error instanceof Error ? error : undefined;

  logger.error('unhandled server error', {
    name: cause?.name ?? 'unknown',
    reason: cause?.message ?? String(error),
    stack: cause?.stack,
    path: request.path,
    method: request.method,
    // "render" or "action", and which router — enough to tell a page that threw
    // from a Server Action that did, without reading the stack.
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
  });
};
