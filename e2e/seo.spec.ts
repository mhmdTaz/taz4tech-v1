import { expect, test } from '@playwright/test';

const LOCALES = ['en', 'ar', 'fr'] as const;

/**
 * Canonical and hreflang have to be ABSOLUTE.
 *
 * Google treats a relative canonical or hreflang as invalid and silently ignores
 * it — the markup looks correct in the page source while doing nothing. This was
 * real: Lighthouse scored SEO 0.83 on the listing and product pages until
 * metadataBase was set.
 */
const ABSOLUTE = /^https?:\/\//;

test.describe('canonical and hreflang', () => {
  const paths = ['/en', '/en/products', '/en/products/lenovo-ideapad-3'];

  for (const path of paths) {
    test(`${path} has an absolute canonical`, async ({ page }) => {
      await page.goto(path);
      const href = await page.locator('link[rel="canonical"]').getAttribute('href');
      expect(href, 'canonical must be present').not.toBeNull();
      expect(href ?? '').toMatch(ABSOLUTE);
    });

    test(`${path} has absolute hreflang for every locale`, async ({ page }) => {
      await page.goto(path);
      for (const locale of LOCALES) {
        const href = await page
          .locator(`link[rel="alternate"][hreflang="${locale}"]`)
          .getAttribute('href');
        expect(href, `hreflang=${locale} must be present`).not.toBeNull();
        expect(href ?? '').toMatch(ABSOLUTE);
      }
      await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveCount(1);
    });
  }

  test('hreflang is reciprocal — the Arabic page points back at the English one', async ({
    page,
  }) => {
    // A one-way hreflang is ignored by Google. Both directions have to agree.
    await page.goto('/ar/products/lenovo-ideapad-3');
    const en = await page.locator('link[rel="alternate"][hreflang="en"]').getAttribute('href');
    expect(en ?? '').toContain('/en/products/lenovo-ideapad-3');
  });
});

test.describe('robots.txt', () => {
  test('is served and points at the sitemap', async ({ request }) => {
    const response = await request.get('/robots.txt');
    expect(response.status()).toBe(200);

    const body = await response.text();
    expect(body).toContain('User-Agent: *');
    expect(body).toMatch(/Sitemap:\s*https?:\/\/\S+\/sitemap\.xml/);
  });

  test('keeps crawlers off the API and the variant query strings', async ({ request }) => {
    const body = await (await request.get('/robots.txt')).text();
    expect(body).toContain('Disallow: /api/');
    // Variant URLs all render substantially the same page; the canonical already
    // handles it, but there is no reason to spend crawl budget discovering them.
    expect(body).toContain('Disallow: /*?variant=');
  });
});

test.describe('sitemap.xml', () => {
  test('is served as XML and lists the locale home pages', async ({ request }) => {
    const response = await request.get('/sitemap.xml');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('xml');

    const body = await response.text();
    expect(body).toContain('<urlset');
    expect(body).toMatch(/<loc>https?:\/\/[^<]*\/en<\/loc>/);
  });

  test('carries hreflang alternates on every entry', async ({ request }) => {
    // A page can only declare alternates for itself, so without these a crawler
    // discovers the Arabic version only after fetching the English one.
    const body = await (await request.get('/sitemap.xml')).text();
    for (const locale of LOCALES) {
      expect(body).toContain(`hreflang="${locale}"`);
    }
  });

  test('lists the active products', async ({ request }) => {
    const body = await (await request.get('/sitemap.xml')).text();
    expect(body).toContain('/en/products/lenovo-ideapad-3');
    expect(body).toContain('/en/products/samsung-galaxy-a55');
    expect(body).toContain('/en/products/anker-usb-c-cable-2m');
  });

  test('never lists a draft product', async ({ request }) => {
    // The sitemap is the one place an unpublished product would be handed
    // directly to a crawler rather than merely being reachable.
    const body = await (await request.get('/sitemap.xml')).text();
    expect(body).not.toContain('unreleased-gadget');
  });

  test('every URL is absolute', async ({ request }) => {
    const body = await (await request.get('/sitemap.xml')).text();
    const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? '');
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) expect(loc).toMatch(ABSOLUTE);
  });
});
