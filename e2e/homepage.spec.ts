import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * The home page.
 *
 * Read-only against the seeded demo catalogue, so these run in parallel with
 * everything else and leave nothing behind.
 */

test.describe('what a cold visitor is told', () => {
  test('leads with what the shop sells', async ({ page }) => {
    await page.goto('/en');

    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Electronics, delivered across Lebanon',
    );
  });

  test('answers the three questions that decide whether to read on', async ({ page }) => {
    /*
     * No reviews, no brand recognition, no card payments — and it asks a
     * stranger to let a driver come to their house. Is anything charged now, do
     * you reach me, will somebody call.
     */
    await page.goto('/en');
    const main = page.locator('main');

    await expect(main).toContainText('Cash on delivery');
    await expect(main).toContainText('All eight governorates');
    await expect(main).toContainText('We call first');
  });

  test('says how buying works before asking for anything', async ({ page }) => {
    await page.goto('/en');
    await expect(page.locator('main')).toContainText('How buying here works');
    await expect(page.locator('main')).toContainText('Nothing is charged');
  });

  test('NO LONGER shows customers the shop configuration', async ({ page }) => {
    /*
     * The page used to open with "Phase 0 · skeleton" and a panel listing the
     * VAT rate, the locales and the shop's own phone number — a configuration
     * dump on the page that decides whether somebody trusts this shop with an
     * address. The seller identity it was accidentally carrying is in the
     * footer now, which is where the law expects it.
     */
    await page.goto('/en');
    const main = page.locator('main');

    await expect(main).not.toContainText('skeleton');
    await expect(main).not.toContainText('Store configuration');
    await expect(main).not.toContainText('VAT');
    await expect(main).not.toContainText('Locales');
  });
});

test.describe('the strips that come out of the catalogue', () => {
  test('offers a way into each collection', async ({ page }) => {
    await page.goto('/en');

    const strip = page.getByRole('region', { name: 'Shop by collection' });
    await expect(strip.getByRole('link', { name: /Laptops/ })).toHaveAttribute(
      'href',
      '/en/collections/laptops',
    );
    // Drafts are not navigation. The demo has one, and it must not appear.
    await expect(strip.getByRole('link', { name: /Staff Picks/ })).toHaveCount(0);
  });

  test('shows the newest products, and a way to the rest', async ({ page }) => {
    await page.goto('/en');

    const strip = page.getByRole('region', { name: 'Just arrived' });

    /*
     * Named, not counted. Other specs publish a product to buy it and archive it
     * again, so any count of the shared catalogue is briefly wrong — the same
     * trap the facets spec fell into. What must be true is that the strip shows
     * real products and leads to the rest.
     */
    await expect(strip.getByRole('link', { name: /Anker/ })).toHaveCount(1);
    await expect(strip.locator('li')).not.toHaveCount(0);
    await expect(strip.getByRole('link', { name: 'See everything' })).toHaveAttribute(
      'href',
      '/en/products',
    );
  });

  test('never shows a draft product', async ({ page }) => {
    // The demo catalogue has one specifically to catch this.
    await page.goto('/en');
    await expect(page.locator('main')).not.toContainText('Unreleased Gadget');
  });

  test('renders product images through the optimiser', async ({ page }) => {
    await page.goto('/en');
    const strip = page.getByRole('region', { name: 'Just arrived' });

    await expect(strip.locator('img').first()).toHaveAttribute('src', /\/_next\/image\?url=/);
  });
});

test.describe('getting somewhere from here', () => {
  test('leads to the catalogue and to how delivery works', async ({ page }) => {
    await page.goto('/en');
    const main = page.locator('main');

    await expect(main.getByRole('link', { name: 'Browse everything' })).toHaveAttribute(
      'href',
      '/en/products',
    );
    await expect(main.getByRole('link', { name: 'How delivery works' })).toHaveAttribute(
      'href',
      '/en/delivery',
    );
  });

  test('has exactly one h1', async ({ page }) => {
    await page.goto('/en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });

  test('describes itself for a search result', async ({ page }) => {
    await page.goto('/en');

    await expect(page).toHaveTitle(/electronics delivered across Lebanon/i);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /cash when your order arrives/,
    );
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the hero and the reassurances are in the HTML', async ({ page }) => {
    // These are static per locale and deliberately outside every Suspense
    // boundary, so a slow catalogue query cannot delay them — and a browser
    // that never runs a script still gets them.
    await page.goto('/en');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('main')).toContainText('Cash on delivery');
    await expect(page.getByRole('link', { name: 'Browse everything' })).toBeVisible();
  });
});

test.describe('other locales', () => {
  test('is translated, not English three times', async ({ page }) => {
    await page.goto('/ar');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('إلكترونيات');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    await page.goto('/fr');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('électronique');
  });

  test('keeps every link inside the locale', async ({ page }) => {
    await page.goto('/ar');

    for (const link of await page.locator('main a[href^="/"]').all()) {
      expect(await link.getAttribute('href')).toMatch(/^\/ar\//);
    }
  });
});

test.describe('accessibility', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`has no WCAG 2.1 AA violations in ${locale}`, async ({ page }) => {
      await page.goto(`/${locale}`);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      if (results.violations.length > 0) console.log(JSON.stringify(results.violations, null, 2));
      expect(results.violations).toEqual([]);
    });
  }
});
