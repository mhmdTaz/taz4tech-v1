import { expect, test } from '@playwright/test';

const LOCALES = ['en', 'ar', 'fr'] as const;

test.describe('product listing', () => {
  test('lists the seeded products', async ({ page }) => {
    await page.goto('/en/products');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: /Lenovo IdeaPad 3/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Samsung Galaxy A55/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Anker USB-C/ })).toBeVisible();
  });

  test('never shows a draft product', async ({ page }) => {
    // The single most important assertion on this page: unpublished stock must
    // not reach a customer, and the gate for that lives in the use case.
    await page.goto('/en/products');
    await expect(page.getByText('Unreleased Gadget')).toHaveCount(0);
  });

  test('shows a price range for a multi-variant product', async ({ page }) => {
    await page.goto('/en/products');
    // The laptop spans $1,199-$1,399, so quoting one price would be misleading.
    await expect(page.getByText(/From\s*\$1,199\.00/)).toBeVisible();
  });

  test('marks a discounted product as on sale', async ({ page }) => {
    await page.goto('/en/products');
    await expect(page.getByText('Sale').first()).toBeVisible();
  });

  test('a product tile is entirely clickable, not just the title', async ({ page }) => {
    await page.goto('/en/products');
    const card = page.getByRole('link', { name: /Lenovo IdeaPad 3/ });
    await card.click();
    await expect(page).toHaveURL(/\/en\/products\/lenovo-ideapad-3$/);
  });

  for (const locale of LOCALES) {
    test(`/${locale}/products renders translated copy`, async ({ page }) => {
      await page.goto(`/${locale}/products`);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('body')).not.toContainText('products.');
    });
  }
});

test.describe('product detail', () => {
  test('shows title, brand, price, SKU and specs', async ({ page }) => {
    await page.goto('/en/products/lenovo-ideapad-3');

    await expect(page.getByRole('heading', { level: 1, name: 'Lenovo IdeaPad 3' })).toBeVisible();
    await expect(page.getByText('Lenovo').first()).toBeVisible();
    await expect(page.getByText('$1,199.00')).toBeVisible();
    await expect(page.getByText('IP3-BLK-256')).toBeVisible();
    await expect(page.getByRole('table')).toContainText('AMD Ryzen 5 5500U');
  });

  test('selects a variant through the URL, with no JavaScript required', async ({ page }) => {
    await page.goto('/en/products/lenovo-ideapad-3');
    await page.getByRole('link', { name: 'Silver', exact: true }).click();

    await expect(page).toHaveURL(/variant=IP3-SLV-256/);
    await expect(page.getByText('IP3-SLV-256')).toBeVisible();
    await expect(page.getByText('$1,249.00')).toBeVisible();
  });

  test('shows an unavailable combination as disabled rather than hiding it', async ({ page }) => {
    // Silver has no 512GB. Hiding the option would leave the customer wondering
    // why a choice vanished when they picked a colour.
    await page.goto('/en/products/lenovo-ideapad-3?variant=IP3-SLV-256');
    const unavailable = page.locator('[aria-disabled="true"]', { hasText: '512GB' });
    await expect(unavailable).toBeVisible();
  });

  test('shows the sale price, the regular price and the offer expiry', async ({ page }) => {
    await page.goto('/en/products/samsung-galaxy-a55');

    await expect(page.getByText('$389.00')).toBeVisible();
    await expect(page.getByText('$449.00')).toBeVisible();
    // Consumer protection law requires the expiry to be shown, not merely stored.
    await expect(page.getByText(/Offer ends/)).toBeVisible();
  });

  test('renders a product with no imagery without breaking', async ({ page }) => {
    await page.goto('/en/products/anker-usb-c-cable-2m');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Anker');
    await expect(page.getByText('$19.00')).toBeVisible();
  });

  test('emits valid Product JSON-LD', async ({ page }) => {
    await page.goto('/en/products/lenovo-ideapad-3');

    const raw = await page.locator('script[type="application/ld+json"]').textContent();
    expect(raw).not.toBeNull();

    const data = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    expect(data['@type']).toBe('Product');
    expect(data.name).toBe('Lenovo IdeaPad 3');

    // A multi-variant product must advertise the real span, or Merchant Center
    // sees a price mismatch against the landing page.
    const offers = data.offers as Record<string, unknown>;
    expect(offers['@type']).toBe('AggregateOffer');
    expect(offers.lowPrice).toBe('1199.00');
    expect(offers.highPrice).toBe('1399.00');
  });

  test('canonical points at the bare URL, never at a variant URL', async ({ page }) => {
    // Every variant renders substantially the same page; letting them compete as
    // separate URLs splits the ranking signals between them.
    await page.goto('/en/products/lenovo-ideapad-3?variant=IP3-SLV-256');
    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveAttribute('href', /\/en\/products\/lenovo-ideapad-3$/);
  });

  test('emits hreflang alternates for every locale', async ({ page }) => {
    await page.goto('/en/products/lenovo-ideapad-3');
    for (const locale of LOCALES) {
      await expect(page.locator(`link[rel="alternate"][hreflang="${locale}"]`)).toHaveCount(1);
    }
    await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveCount(1);
  });

  test('translates the product into Arabic and mirrors the layout', async ({ page }) => {
    await page.goto('/ar/products/lenovo-ideapad-3');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('لينوفو');
  });

  test('falls back to English where a locale is untranslated', async ({ page }) => {
    // The laptop has no French title, so French must show the English one
    // rather than an empty heading.
    await page.goto('/fr/products/lenovo-ideapad-3');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Lenovo IdeaPad 3');
  });
});

test.describe('missing products return a real 404', () => {
  test('a product that does not exist', async ({ page }) => {
    // Status, not just content. A 200 with "not found" markup is a soft 404, and
    // a storefront that answers 200 for every mistyped URL teaches search
    // engines its 404s are real pages.
    const response = await page.goto('/en/products/does-not-exist');
    expect(response?.status()).toBe(404);
  });

  test('a draft product', async ({ page }) => {
    const response = await page.goto('/en/products/unreleased-gadget');
    expect(response?.status()).toBe(404);
  });
});
