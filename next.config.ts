import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  /**
   * Caching is opt-in in Next 16. Nothing is cached unless a "use cache" boundary
   * says so, which is the safe default for a storefront where a stale price or a
   * stale stock count is worse than a slower render.
   */
  cacheComponents: true,

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
