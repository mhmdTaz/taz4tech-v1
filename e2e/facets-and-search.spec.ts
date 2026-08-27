import { expect, test } from '@playwright/test';

/** The demo catalogue: Lenovo IdeaPad 3, Samsung Galaxy A55, Anker cable, plus a draft. */

const tiles = (page: import('@playwright/test').Page) =>
  page.locator('main ul li a[href*="/products/"]');

/**
 * A PRODUCT tile, not a facet link.
 *
 * getByRole('link', { name: /Anker/ }) matches both — the brand facet is also a
 * link called "Anker". Scoping to the results grid is the difference between
 * asserting on the product and asserting on the filter that would find it.
 */
const productTile = (page: import('@playwright/test').Page, name: RegExp) =>
  tiles(page).filter({ hasText: name });

test.describe('search', () => {
  test('finds a product by an English word', async ({ page }) => {
    await page.goto('/en/products?q=laptop');
    await expect(tiles(page)).toHaveCount(1);
    await expect(productTile(page, /Lenovo IdeaPad 3/)).toHaveCount(1);
  });

  test('finds an English product from an Arabic query', async ({ page }) => {
    // The catalogue is loaded in English from suppliers; a large share of
    // customers search in Arabic. Without synonym expansion this returns nothing
    // — not a ranking problem, an empty shop.
    await page.goto(`/en/products?q=${encodeURIComponent('لابتوب')}`);
    await expect(productTile(page, /Lenovo IdeaPad 3/)).toHaveCount(1);
  });

  test('finds a product from a French query', async ({ page }) => {
    await page.goto(`/en/products?q=${encodeURIComponent('câble')}`);
    await expect(productTile(page, /Anker/)).toHaveCount(1);
  });

  test('keeps the query in the box so it can be refined', async ({ page }) => {
    await page.goto('/en/products?q=laptop');
    await expect(page.getByRole('searchbox')).toHaveValue('laptop');
  });

  test('searching is a plain form submit — the result is a URL', async ({ page }) => {
    await page.goto('/en/products');
    await page.getByRole('searchbox').fill('cable');
    await page.getByRole('button', { name: /Search/ }).click();

    await expect(page).toHaveURL(/[?&]q=cable/);
    await expect(productTile(page, /Anker/)).toHaveCount(1);
  });

  test('says nothing matched, distinctly from an empty catalogue', async ({ page }) => {
    // "Come back later" and "widen your filters" are different messages. Showing
    // the first for the second is how a customer concludes the shop is empty.
    await page.goto('/en/products?q=zzzznothing');
    await expect(tiles(page)).toHaveCount(0);
    await expect(page.getByText(/Nothing matches those filters/)).toBeVisible();
  });
});

test.describe('facets', () => {
  test('lists brands with counts', async ({ page }) => {
    await page.goto('/en/products');
    const panel = page.getByRole('complementary', { name: /Filters/ });
    await expect(panel.getByRole('link', { name: /Lenovo/ })).toBeVisible();
    await expect(panel.getByRole('link', { name: /Samsung/ })).toBeVisible();
    await expect(panel.getByRole('link', { name: /Anker/ })).toBeVisible();
  });

  test('filtering by brand narrows the results', async ({ page }) => {
    await page.goto('/en/products');
    await page
      .getByRole('complementary', { name: /Filters/ })
      .getByRole('link', { name: /Lenovo/ })
      .click();

    await expect(page).toHaveURL(/brand=Lenovo/);
    await expect(tiles(page)).toHaveCount(1);
  });

  test('a selected facet is announced, not only coloured', async ({ page }) => {
    // aria-current, not aria-pressed: aria-pressed is only valid on a button
    // role and axe rejects it on a link as a critical violation.
    await page.goto('/en/products?brand=Lenovo');
    const selected = page
      .getByRole('complementary', { name: /Filters/ })
      .getByRole('link', { name: /Lenovo/ });
    await expect(selected).toHaveAttribute('aria-current', 'true');
    // The state is in the accessible name too, since aria-current alone is
    // announced inconsistently across readers.
    await expect(selected).toContainText('selected');
  });

  test('every brand stays selectable while one is filtered', async ({ page }) => {
    // The behaviour that makes facets usable: choosing Lenovo must not collapse
    // the list to Lenovo, or the customer cannot switch to Samsung without
    // first clearing the filter.
    await page.goto('/en/products?brand=Lenovo');
    const panel = page.getByRole('complementary', { name: /Filters/ });
    await expect(panel.getByRole('link', { name: /Samsung/ })).toBeVisible();
    await expect(panel.getByRole('link', { name: /Anker/ })).toBeVisible();
  });

  test('clicking a selected facet again removes it', async ({ page }) => {
    await page.goto('/en/products?brand=Lenovo');
    await page
      .getByRole('complementary', { name: /Filters/ })
      .getByRole('link', { name: /Lenovo/ })
      .click();

    await expect(page).not.toHaveURL(/brand=Lenovo/);
    await expect(tiles(page)).toHaveCount(3);
  });

  test('filters by a variant option', async ({ page }) => {
    await page.goto('/en/products?opt.Storage=128GB');
    await expect(productTile(page, /Samsung Galaxy A55/)).toHaveCount(1);
    await expect(tiles(page)).toHaveCount(1);
  });

  test('clears every filter at once', async ({ page }) => {
    await page.goto('/en/products?brand=Lenovo&q=laptop');
    await page
      .getByRole('link', { name: /Clear all filters/ })
      .first()
      .click();

    await expect(page).toHaveURL(/\/en\/products$/);
    await expect(tiles(page)).toHaveCount(3);
  });

  test('offers no clear-filters link when nothing is filtered', async ({ page }) => {
    await page.goto('/en/products');
    await expect(page.getByRole('link', { name: /Clear all filters/ })).toHaveCount(0);
  });

  test('combines a search with a facet', async ({ page }) => {
    await page.goto('/en/products?q=laptop&brand=Lenovo');
    await expect(tiles(page)).toHaveCount(1);
    await expect(page.getByRole('searchbox')).toHaveValue('laptop');
  });

  test('keeps the search when a facet is toggled', async ({ page }) => {
    // Toggling a brand must not silently discard what the customer typed.
    await page.goto('/en/products?q=laptop');
    await page
      .getByRole('complementary', { name: /Filters/ })
      .getByRole('link', { name: /Lenovo/ })
      .click();

    await expect(page).toHaveURL(/q=laptop/);
    await expect(page).toHaveURL(/brand=Lenovo/);
  });
});

test.describe('filtered listings in every locale', () => {
  for (const locale of ['en', 'ar', 'fr'] as const) {
    test(`/${locale}/products renders the filter panel translated`, async ({ page }) => {
      await page.goto(`/${locale}/products?brand=Lenovo`);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      // No raw message keys leaked into the page.
      await expect(page.locator('body')).not.toContainText('products.');
      await expect(page.getByRole('complementary')).toBeVisible();
    });
  }
});
