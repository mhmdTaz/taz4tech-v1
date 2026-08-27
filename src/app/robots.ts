import { getConfig } from '@platform/config';
import type { MetadataRoute } from 'next';

/**
 * robots.txt
 *
 * Everything is crawlable except the API surface and the variant query strings.
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
        disallow: ['/api/', '/*?variant='],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
