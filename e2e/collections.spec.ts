import { expect, test } from '@playwright/test';

/**
 * Demo collections: "laptops" (rule-based, brand=Lenovo), "deals" (price rule
 * under $500 plus a pinned laptop), and "staff-picks" (a draft).
 */

/**
 * A product CARD, not just any link to a product.
 *
 * Every tile now holds two anchors pointing at the same product page: the card
 * itself, and the quick-view trigger overlaid on it — which is a link so that it
 * still goes somewhere useful before hydration. Counting anchors would count
 * every product twice. The card is the one that contains the title heading.
 */
const tiles = (page: import('@playwright/test').Page) =>
  page.locator('main ul li a[href*="/products/"]').filter({ has: page.locator('h3') });

const productTile = (page: import('@playwright/test').Page, name: RegExp) =>
  tiles(page).filter({ hasText: name });

test.describe('collection index', () => {
  test('lists the published collections', async ({ page }) => {
    await page.goto('/en/collections');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: /Laptops/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Deals/ })).toBeVisible();
  });

  test('never lists a draft collection', async ({ page }) => {
    await page.goto('/en/collections');
    await expect(page.getByText('Staff Picks')).toHaveCount(0);
  });

  test('links through to the collection', async ({ page }) => {
    await page.goto('/en/collections');
    await page.getByRole('link', { name: /Laptops/ }).click();
    await expect(page).toHaveURL(/\/en\/collections\/laptops$/);
  });
});

test.describe('a rule-based collection', () => {
  test('shows only the products its rules select', async ({ page }) => {
    await page.goto('/en/collections/laptops');
    await expect(productTile(page, /Lenovo IdeaPad 3/)).toHaveCount(1);
    await expect(tiles(page)).toHaveCount(1);
  });

  test('shows its own title and description, not the catalogue heading', async ({ page }) => {
    await page.goto('/en/collections/laptops');
    await expect(page.getByRole('heading', { level: 1, name: 'Laptops' })).toBeVisible();
  });
});

test.describe('a curated collection', () => {
  test('includes a pinned product the rules would exclude', async ({ page }) => {
    // "deals" is everything under $500, PLUS a pinned $1,199 laptop.
    await page.goto('/en/collections/deals');
    await expect(productTile(page, /Lenovo IdeaPad 3/)).toHaveCount(1);
    await expect(productTile(page, /Anker/)).toHaveCount(1);
  });

  test('does not let a pinned product survive a filter it fails', async ({ page }) => {
    // The nesting that matters: membership is ORed, the customer filter is ANDed
    // on top. Filtering to Anker must drop the pinned Lenovo.
    await page.goto('/en/collections/deals?brand=Anker');
    await expect(productTile(page, /Anker/)).toHaveCount(1);
    await expect(productTile(page, /Lenovo/)).toHaveCount(0);
  });
});

test.describe('a collection reuses the listing behaviour', () => {
  test('offers facets scoped to the collection', async ({ page }) => {
    // "laptops" is brand=Lenovo, so Samsung is genuinely not a member. Offering
    // it as a filter would hand the customer a choice that returns nothing.
    // (The Samsung IS in "deals" — it costs $389, under that collection's $500
    // rule — so this assertion belongs here, not there.)
    await page.goto('/en/collections/laptops');
    const panel = page.getByRole('complementary', { name: /Filters/ });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('link', { name: /Lenovo/ })).toBeVisible();
    await expect(panel.getByRole('link', { name: /Samsung/ })).toHaveCount(0);
    await expect(panel.getByRole('link', { name: /Anker/ })).toHaveCount(0);
  });

  test('facet links stay inside the collection', async ({ page }) => {
    await page.goto('/en/collections/deals');
    await page
      .getByRole('complementary', { name: /Filters/ })
      .getByRole('link', { name: /Anker/ })
      .click();

    await expect(page).toHaveURL(/\/en\/collections\/deals\?/);
    await expect(page).toHaveURL(/brand=Anker/);
  });

  test('search works within a collection', async ({ page }) => {
    await page.goto('/en/collections/deals?q=cable');
    await expect(productTile(page, /Anker/)).toHaveCount(1);
    await expect(tiles(page)).toHaveCount(1);
  });
});

test.describe('missing collections return a real 404', () => {
  test('a collection that does not exist', async ({ page }) => {
    const response = await page.goto('/en/collections/does-not-exist');
    expect(response?.status()).toBe(404);
  });

  test('a draft collection', async ({ page }) => {
    const response = await page.goto('/en/collections/staff-picks');
    expect(response?.status()).toBe(404);
  });
});

test.describe('collections in every locale', () => {
  for (const locale of ['en', 'ar', 'fr'] as const) {
    test(`/${locale}/collections/laptops renders translated`, async ({ page }) => {
      await page.goto(`/${locale}/collections/laptops`);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('body')).not.toContainText('collections.');
    });
  }

  test('uses the Arabic collection title where translated', async ({ page }) => {
    await page.goto('/ar/collections/laptops');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('حواسيب');
  });

  test('falls back to English where untranslated', async ({ page }) => {
    // "Deals" has no French title.
    await page.goto('/fr/collections/deals');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Deals');
  });
});

test.describe('sitemap', () => {
  test('lists published collections and not drafts', async ({ request }) => {
    const body = await (await request.get('/sitemap.xml')).text();
    expect(body).toContain('/en/collections/laptops');
    expect(body).toContain('/en/collections/deals');
    expect(body).not.toContain('staff-picks');
  });
});
