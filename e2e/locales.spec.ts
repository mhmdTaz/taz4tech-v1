import { expect, test } from '@playwright/test';

const LOCALES = ['en', 'ar', 'fr'] as const;

const EXPECTED_DIRECTION: Record<(typeof LOCALES)[number], 'ltr' | 'rtl'> = {
  en: 'ltr',
  ar: 'rtl',
  fr: 'ltr',
};

test.describe('locale routing', () => {
  for (const locale of LOCALES) {
    test(`/${locale} renders with the right lang and dir`, async ({ page }) => {
      await page.goto(`/${locale}`);

      const html = page.locator('html');
      await expect(html).toHaveAttribute('lang', locale);
      await expect(html).toHaveAttribute('dir', EXPECTED_DIRECTION[locale]);
    });

    test(`/${locale} shows translated copy, not a raw message key`, async ({ page }) => {
      await page.goto(`/${locale}`);

      // A missing translation surfaces as the key itself, which is easy to miss
      // in review and impossible to miss here.
      await expect(page.locator('body')).not.toContainText('home.');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });
  }

  test('a bare path is redirected to a locale subdirectory', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/(en|ar|fr)$/);
  });

  test('an unknown locale is a 404, not a silent redirect', async ({ page }) => {
    const response = await page.goto('/de');
    expect(response?.status()).toBe(404);
  });

  test('Arabic differs from English, proving the bundle actually loaded', async ({ page }) => {
    await page.goto('/en');
    const english = await page.getByRole('heading', { level: 1 }).textContent();

    await page.goto('/ar');
    const arabic = await page.locator('main p').first().textContent();

    expect(english?.trim().length).toBeGreaterThan(0);
    // The tagline is translated even though the brand name is not.
    expect(arabic ?? '').toMatch(/[؀-ۿ]/);
  });
});

test.describe('bare paths reach a locale', () => {
  /*
   * These pin a bug that hid for a whole phase.
   *
   * The proxy matcher excluded "files with an extension" using an UNESCAPED dot,
   * so `.*.*.*` matched any path of two characters or more and the middleware
   * ran on `/` alone. The home page redirected, which is all anyone checked, and
   * every other bare path 404ed instead of finding its locale.
   */
  for (const path of ['/products', '/collections', '/collections/laptops']) {
    test(`${path} redirects into the default locale`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`/en${path}$`));
    });
  }

  test('/ still redirects, which is the case that always worked', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/en$/);
  });

  test('a path with a real extension is left alone', async ({ request }) => {
    // The exclusion the escaped dot is actually for: robots.txt must not be
    // rewritten to /en/robots.txt.
    expect((await request.get('/robots.txt')).status()).toBe(200);
  });

  test('/admin is never rewritten into a locale', async ({ page }) => {
    // It lives outside the locale tree; /en/admin does not exist.
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });
});
