import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

/**
 * Next 16 renamed middleware.ts to proxy.ts. The old name still works but is
 * deprecated; this file is also what keeps the edge runtime entry point.
 *
 * Its whole job is locale negotiation: send a bare path to the right /en, /ar or
 * /fr subdirectory.
 */
export default createMiddleware(routing);

export const config = {
  // Everything except Next internals, the API surface, and files with an extension.
  matcher: ['/((?!api|_next|_vercel|.*..*).*)'],
};
