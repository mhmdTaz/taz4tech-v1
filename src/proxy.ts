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
  /*
   * Everything except Next internals, the API surface, the admin area, and files
   * with an extension.
   *
   * The `\\.` is load-bearing and was previously a bare `.`, which quietly broke
   * this: an unescaped dot matches ANY character, so `.*.*.*` excluded every
   * path of two characters or more and the middleware ran on `/` alone. The
   * homepage redirected correctly, so nothing looked wrong, while `/products`
   * 404ed instead of redirecting to `/en/products`.
   *
   * `admin` is excluded because it is deliberately outside the locale tree —
   * without it, locale negotiation would rewrite `/admin` to `/en/admin`, which
   * does not exist.
   *
   * `media` for the same reason, with an extra twist. A picture is the same
   * picture in Arabic, so catalogue images are served from one URL rather than
   * three — and those URLs are content-addressed, `/media/<sha256>`, with no
   * extension. The dot rule above therefore does not exclude them, and locale
   * negotiation swallowed every image on the site. Found by the e2e spec, which
   * asked for a stored image and got a 404.
   */
  matcher: ['/((?!api|admin|media|_next|_vercel|.*\\..*).*)'],
};
