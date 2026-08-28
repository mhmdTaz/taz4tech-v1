import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { ADMIN_PASSWORD } from '../playwright.config';
import { xlsxUpload } from './support/workbook';

/**
 * The product page as a shop front: a gallery you can move through, a trail back
 * out, and somewhere to go next.
 *
 * Read-only against the seeded demo catalogue.
 */

const LAPTOP = '/en/products/lenovo-ideapad-3';

test.describe.configure({ mode: 'serial' });

const jsonLd = async (page: Page): Promise<Record<string, unknown>[]> => {
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  return blocks.map((block) => JSON.parse(block) as Record<string, unknown>);
};

test.describe('the gallery', () => {
  test('shows every picture as a thumbnail, including the one on show', async ({ page }) => {
    // A strip that reshuffles when you click is a strip you lose your place in.
    await page.goto(LAPTOP);

    const thumbs = page.getByRole('link', { name: /Show image/ });
    await expect(thumbs).toHaveCount(2);
    await expect(page.getByRole('link', { name: 'Show image 1' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  test('changes the picture through the URL, with no JavaScript required', async ({ page }) => {
    /*
     * The same choice as the variant picker beside it: a link, not client state,
     * so a picture is shareable, crawlable and survives a reload.
     */
    await page.goto(LAPTOP);
    await page.getByRole('link', { name: 'Show image 2' }).click();

    await expect(page).toHaveURL(/\?image=1$/);
    await expect(page.getByRole('link', { name: 'Show image 2' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  test('keeps the chosen variant when the picture changes', async ({ page }) => {
    // Dropping ?variant= here would silently reset a customer's colour and size,
    // which shows up later as an order for the wrong SKU.
    await page.goto(`${LAPTOP}?variant=IP3-BLK-512`);
    await page.getByRole('link', { name: 'Show image 2' }).click();

    await expect(page).toHaveURL(/variant=IP3-BLK-512/);
    await expect(page).toHaveURL(/image=1/);
    await expect(page.locator('main')).toContainText('IP3-BLK-512');
  });

  test('the first picture is the bare product URL', async ({ page }) => {
    // ?image=0 would be a second URL for the canonical page.
    await page.goto(`${LAPTOP}?image=1`);
    await expect(page.getByRole('link', { name: 'Show image 1' })).toHaveAttribute('href', LAPTOP);
  });

  test('falls back to the first picture rather than showing an empty frame', async ({ page }) => {
    // A query string a customer can edit must never produce a page with no
    // photograph on it.
    for (const value of ['99', '-1', 'two', '']) {
      await page.goto(`${LAPTOP}?image=${value}`);
      await expect(page.getByRole('link', { name: 'Show image 1' })).toHaveAttribute(
        'aria-current',
        'true',
      );
      await expect(page.locator('main img').first()).toBeVisible();
    }
  });

  test('gives the thumbnails link names, not four copies of the alt text', async ({ page }) => {
    // Otherwise a screen reader hears the same product description four times
    // with no way to tell the links apart.
    await page.goto(LAPTOP);

    for (const link of await page.getByRole('link', { name: /Show image/ }).all()) {
      await expect(link.locator('img')).toHaveAttribute('alt', '');
    }
  });
});

test.describe('the breadcrumb', () => {
  test('is a path back out, ending on the page you are on', async ({ page }) => {
    await page.goto(LAPTOP);

    const trail = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(trail.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/en');
    await expect(trail.getByRole('link', { name: 'Products' })).toHaveAttribute(
      'href',
      '/en/products',
    );

    // The page you are on is not a link to itself.
    await expect(trail.getByText('Lenovo IdeaPad 3')).toHaveAttribute('aria-current', 'page');
  });

  test('is published as BreadcrumbList, with absolute URLs', async ({ page }) => {
    /*
     * Google ignores a relative `item` exactly as it ignores a relative
     * canonical — silently, while the markup looks perfectly correct.
     */
    await page.goto(LAPTOP);

    const breadcrumb = (await jsonLd(page)).find((block) => block['@type'] === 'BreadcrumbList');
    expect(breadcrumb).toBeDefined();

    const items = breadcrumb?.itemListElement as { position: number; item: string }[];
    expect(items.map((item) => item.position)).toEqual([1, 2, 3]);
    for (const item of items) expect(item.item).toMatch(/^https?:\/\//);
  });

  test('does not take the product data down with it', async ({ page }) => {
    // Two blocks rather than one @graph, so a malformed Product cannot cost the
    // breadcrumb that actually shows in the result.
    await page.goto(LAPTOP);

    const types = (await jsonLd(page)).map((block) => block['@type']);
    expect(types).toContain('Product');
    expect(types).toContain('BreadcrumbList');
  });
});

test.describe('more from the same brand', () => {
  /*
   * These need TWO active products sharing a brand, which the demo catalogue
   * cannot supply: its three active products are three different brands, and the
   * collections spec pins their counts exactly, so adding one there breaks two
   * assertions elsewhere. So this pair is imported, published, used and archived
   * — the same shape as the stock spec, and the reason this file is serial.
   */
  const HEADERS = ['SKU', 'Title', 'Price', 'Brand', 'Status'] as const;
  const BRAND = 'Zzrelatedbrand';
  const unique = () => `Zzrelated${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;

  const signIn = async (page: Page) => {
    await page.goto('/admin/login');
    if (!page.url().includes('/admin/login')) return;

    await page.getByLabel('Password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible();
  };

  const setStatus = async (page: Page, token: string, to: string) => {
    await page.goto(`/admin/products?q=${encodeURIComponent(token)}`);
    await page.getByLabel('Select every product on this page').check();
    await page.getByLabel('Change', { exact: true }).selectOption('set_status');
    await page.getByLabel('To', { exact: true }).selectOption(to);
    await page.getByRole('button', { name: /^Check/ }).click();
    await page.getByRole('button', { name: /^Apply/ }).click();
    await expect(page.locator('main').getByRole('status')).toContainText('Updated');
  };

  test('offers other products by that brand, never the one you are reading', async ({ page }) => {
    const first = unique();
    const second = unique();

    await signIn(page);
    await page.goto('/admin/import');
    await page
      .getByLabel('Catalogue spreadsheet (.xlsx)')
      .setInputFiles(
        await xlsxUpload('related.xlsx', [
          HEADERS,
          [`RL-${crypto.randomUUID().slice(0, 8)}`, first, '19.99', BRAND, 'draft'],
          [`RL-${crypto.randomUUID().slice(0, 8)}`, second, '29.99', BRAND, 'draft'],
        ]),
      );
    await page.getByRole('button', { name: /^Import 2 product/ }).click();
    await expect(page.locator('main').getByRole('status')).toContainText('Imported');

    await setStatus(page, BRAND, 'active');
    try {
      await page.goto(`/en/products/${first.toLowerCase()}`);

      const strip = page.getByRole('region', { name: new RegExp(`More from ${BRAND}`) });
      await expect(strip.getByRole('link', { name: new RegExp(second, 'i') })).toHaveCount(1);
      // Never the product you are already reading.
      await expect(strip.getByRole('link', { name: new RegExp(first, 'i') })).toHaveCount(0);
    } finally {
      await setStatus(page, BRAND, 'archived');
    }
  });

  test('shows nothing at all rather than an empty heading', async ({ page }) => {
    // The Anker cable is the only Anker product in the demo catalogue.
    await page.goto('/en/products/anker-usb-c-cable-2m');
    await expect(page.getByRole('region', { name: /More from/ })).toHaveCount(0);
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the gallery and the breadcrumb both work', async ({ page }) => {
    await page.goto(LAPTOP);

    await page.getByRole('link', { name: 'Show image 2' }).click();
    await expect(page).toHaveURL(/image=1/);

    await page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Products' })
      .click();
    await expect(page).toHaveURL(/\/en\/products$/);
  });
});

test.describe('other locales', () => {
  test('keeps the trail and the gallery inside the locale', async ({ page }) => {
    await page.goto('/ar/products/lenovo-ideapad-3');

    const trail = page.getByRole('navigation', { name: 'مسار التنقّل' });
    await expect(trail.getByRole('link').first()).toHaveAttribute('href', '/ar');
    await expect(page.getByRole('link', { name: /أظهر الصورة/ }).first()).toBeVisible();
  });
});

test.describe('accessibility', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`the product page has no WCAG 2.1 AA violations in ${locale}`, async ({ page }) => {
      await page.goto(`/${locale}/products/lenovo-ideapad-3?image=1`);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      if (results.violations.length > 0) console.log(JSON.stringify(results.violations, null, 2));
      expect(results.violations).toEqual([]);
    });
  }
});
