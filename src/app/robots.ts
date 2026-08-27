import { getConfig } from '@platform/config';
import type { MetadataRoute } from 'next';

/**
 * robots.txt
 *
 * Everything is crawlable except the API surface, the admin area and the variant
 * query strings.
 *
 * The /admin disallow is a crawl-budget instruction, not a security control — a
 * robots.txt entry advertises a path as much as it hides it. Access is enforced
 * by the session check on every admin page and action; the admin layout also
 * sends `noindex` for a crawler that fetches anyway.
 *
 * Cart and checkout are personal and have nothing to rank for. The order
 * confirmation matters most: it carries a name, a phone number and a street
 * address against a URL whose numbers are sequential, so it sends `noindex,
 * nofollow` of its own as well as being disallowed here.
 *
 * The `?variant=` disallow matters: every option combination is a distinct URL
 * by design (so it can be shared and works without JavaScript), but they all
 * render substantially the same page. The canonical already points at the bare
 * URL; this stops crawl budget being spent discovering the duplicates in the
 * first place.
 */
export default function robots(): MetadataRoute.Robots {
  const { siteUrl } = getConfig();

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/admin', '/*/cart', '/*/checkout', '/*?variant='],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
