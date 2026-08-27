import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  /**
   * OFF, deliberately — this reverses the plan's original choice, on evidence.
   *
   * Cache Components (partial prerendering) flushes a prerendered shell before
   * the dynamic part has run. On a product page the 404 decision needs a
   * database read, so the HTTP status is already committed as 200 by the time
   * notFound() fires. Measured on this codebase:
   *
   *   cacheComponents: true   ->  200 + "not found" body   (a SOFT 404)
   *   cacheComponents: false  ->  404
   *
   * A storefront whose archived and mistyped product URLs all answer 200 teaches
   * search engines that its 404s are real pages. For a catalogue that churns —
   * products archived, SKUs discontinued — that is continuous damage, in a
   * vertical where organic reach is already hard-won.
   *
   * Neither escape hatch works: `dynamic: 'force-dynamic'` is rejected outright
   * as incompatible with cacheComponents, and `instant: false` controls
   * PREFETCHING rather than response blocking — it silences the build error
   * while leaving the soft 404 in place, which is worse than no fix at all.
   *
   * The plan's actual goal is preserved. It wanted caching opt-in "because a
   * stale price is worse than a slower render", and Next 15+ already defaults to
   * uncached data — so turning this off costs the prerendered shell, not price
   * freshness. Revisit with "use cache" plus tag-based invalidation once product
   * pages are cacheable on purpose rather than by default.
   */
  cacheComponents: false,

  images: {
    /**
     * WebP only. Next 16.3.3 patches an AVIF decoder RCE by disabling AVIF; listing
     * it here would be a request for a format the patched build will not produce.
     */
    formats: ['image/webp'],
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },

  /** Type errors fail the build. Linting is Biome's job, run as its own CI check. */
  typescript: { ignoreBuildErrors: false },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
