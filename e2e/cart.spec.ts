import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * The cart.
 *
 * Read-only against the seeded demo catalogue — the cart lives in a cookie, so
 * every test starts with an empty one and leaves nothing behind for anyone else.
 */

const cartLink = (page: Page) => page.getByRole('link', { name: /^Cart/ });

/**
 * The "n in cart" confirmation.
 *
 * Matched by text rather than by role: the product page carries two status
 * regions — this one and the stock line — and both are exactly what they should
 * be, so the test is what has to be specific.
 */
const inCart = (page: Page, count: number) => page.getByText(`${count} in cart`);
const lines = (page: Page) => page.locator('main ul > li');

/**
 * Add one of a variant from its product page, and WAIT for the post to land.
 *
 * The wait is not decoration. Clicking a form's submit button returns before the
 * redirect has been followed, so a test that navigated straight afterwards would
 * race the Set-Cookie and see an empty cart — which is a test failing for a
 * reason that has nothing to do with what it is testing.
 */
const addFromPdp = async (page: Page, slug: string, variant?: string) => {
  await page.goto(`/en/products/${slug}${variant === undefined ? '' : `?variant=${variant}`}`);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByText(/in cart/)).toBeVisible();
};

test.describe('adding', () => {
  test('adds from the product page and says so without leaving it', async ({ page }) => {
    // Adding a second thing should not cost a navigation each time, so the form
    // returns the customer to the page they were on.
    await addFromPdp(page, 'anker-usb-c-cable-2m');

    await expect(page).toHaveURL(/\/en\/products\/anker-usb-c-cable-2m/);
    await expect(inCart(page, 1)).toBeVisible();
  });

  test('shows the count in the header, on every page', async ({ page }) => {
    await addFromPdp(page, 'anker-usb-c-cable-2m');

    await page.goto('/en/products');
    await expect(cartLink(page)).toHaveAccessibleName(/1 item/);
  });

  test('merges a second add of the same variant', async ({ page }) => {
    await addFromPdp(page, 'anker-usb-c-cable-2m');
    await page.getByRole('button', { name: 'Add to cart' }).click();

    await expect(inCart(page, 2)).toBeVisible();
    await page.goto('/en/cart');
    await expect(lines(page)).toHaveCount(1);
  });

  test('keeps different variants of one product apart', async ({ page }) => {
    // The cart is keyed by SKU, which identifies a variant — not by product.
    await addFromPdp(page, 'lenovo-ideapad-3', 'IP3-BLK-256');
    await addFromPdp(page, 'lenovo-ideapad-3', 'IP3-BLK-512');

    await page.goto('/en/cart');
    await expect(lines(page)).toHaveCount(2);
  });

  test('adds the variant that is selected, not the default', async ({ page }) => {
    await addFromPdp(page, 'lenovo-ideapad-3', 'IP3-BLK-512');

    await page.goto('/en/cart');
    await expect(lines(page).first()).toContainText('$1,399.00');
  });
});

test.describe('the cart page', () => {
  test('is empty to begin with, and offers a way out', async ({ page }) => {
    await page.goto('/en/cart');

    await expect(page.getByText('Your cart is empty.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue shopping' })).toBeVisible();
  });

  test('prices from the CATALOGUE, not from the cookie', async ({ page }) => {
    // The cookie holds SKUs and quantities and nothing else, precisely so that a
    // customer cannot set the price by editing it.
    await addFromPdp(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/cart');

    await expect(lines(page).first()).toContainText('$19.00');
  });

  test('multiplies the line total by the quantity', async ({ page }) => {
    await addFromPdp(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/cart');

    await page.getByLabel('Quantity').fill('3');
    await page.getByRole('button', { name: 'Update' }).click();

    await expect(lines(page).first()).toContainText('$57.00');
  });

  test('sums the subtotal across lines', async ({ page }) => {
    await addFromPdp(page, 'anker-usb-c-cable-2m');
    await addFromPdp(page, 'samsung-galaxy-a55');

    await page.goto('/en/cart');
    // $19.00 + $389.00 — the Samsung is on offer, and the offer price is what
    // the customer pays.
    await expect(page.getByRole('region', { name: 'Subtotal' })).toContainText('$408.00');
  });

  test('shows the was-price on a line that is on offer', async ({ page }) => {
    await addFromPdp(page, 'samsung-galaxy-a55');
    await page.goto('/en/cart');

    await expect(lines(page).first()).toContainText('$449.00');
    await expect(lines(page).first()).toContainText('$389.00');
  });

  test('links a line back to the exact variant', async ({ page }) => {
    await addFromPdp(page, 'lenovo-ideapad-3', 'IP3-BLK-512');
    await page.goto('/en/cart');

    await lines(page).first().getByRole('link').first().click();
    await expect(page).toHaveURL(/variant=IP3-BLK-512/);
  });

  test('removes a line', async ({ page }) => {
    await addFromPdp(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/cart');

    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Your cart is empty.')).toBeVisible();
  });

  test('treats a quantity of zero as a removal', async ({ page }) => {
    // Which is what typing 0 into the box means to anyone who has used a cart.
    await addFromPdp(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/cart');

    await page.getByLabel('Quantity').fill('0');
    await page.getByRole('button', { name: 'Update' }).click();

    await expect(page.getByText('Your cart is empty.')).toBeVisible();
  });

  test('is kept out of the search index', async ({ page }) => {
    // Personal, and with nothing to rank for.
    await page.goto('/en/cart');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('adds to the cart from the product page', async ({ page }) => {
    /*
     * The whole reason these are plain forms. Before hydration — a real slice of
     * the first taps on a Lebanese mobile connection — and with JavaScript
     * unavailable, a button that silently does nothing is the worst version of
     * this control.
     */
    await addFromPdp(page, 'anker-usb-c-cable-2m');
    await expect(inCart(page, 1)).toBeVisible();
  });

  test('changes a quantity and removes a line', async ({ page }) => {
    await addFromPdp(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/cart');

    await page.getByLabel('Quantity').fill('2');
    await page.getByRole('button', { name: 'Update' }).click();
    await expect(lines(page).first()).toContainText('$38.00');

    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Your cart is empty.')).toBeVisible();
  });

  test('carries the count in the header', async ({ page }) => {
    await addFromPdp(page, 'anker-usb-c-cable-2m');
    await expect(cartLink(page)).toHaveAccessibleName(/1 item/);
  });
});

test.describe('a hand-edited cookie', () => {
  test('is an empty cart, not an error page', async ({ page, context }) => {
    // A corrupted cookie is a cart the customer refills, which is annoying,
    // rather than an error page, which is worse.
    await context.addCookies([
      { name: 'taz_cart', value: 'not-a-real-cart!!', url: 'http://127.0.0.1:3000' },
    ]);

    const response = await page.goto('/en/cart');
    expect(response?.status()).toBe(200);
    await expect(page.getByText('Your cart is empty.')).toBeVisible();
  });

  test('cannot put a draft product in the cart', async ({ page, context }) => {
    /*
     * The single gate, checked from the outside. A SKU asked for directly must
     * not reach around the status filter — that is exactly how a draft would end
     * up priced and ordered.
     */
    const cookie = btoa(JSON.stringify([{ s: 'DRAFT-1', q: 1 }]))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');

    await context.addCookies([{ name: 'taz_cart', value: cookie, url: 'http://127.0.0.1:3000' }]);

    await page.goto('/en/cart');
    await expect(page.getByText('No longer available')).toBeVisible();
    await expect(page.getByText('Your cart is empty.')).toBeVisible();
  });

  test('forgets a line that no longer exists rather than reporting it forever', async ({
    page,
    context,
  }) => {
    const cookie = btoa(JSON.stringify([{ s: 'NOT-A-SKU', q: 1 }]))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');

    await context.addCookies([{ name: 'taz_cart', value: cookie, url: 'http://127.0.0.1:3000' }]);

    await page.goto('/en/cart');
    await expect(page.getByText('No longer available')).toBeVisible();

    // Cleared by an explicit button, not by rendering the page: a cart that
    // quietly shrinks while you look at it is worse than one that asks.
    await page.getByRole('button', { name: 'Clear them' }).click();
    await expect(page.getByText('No longer available')).toHaveCount(0);
    await expect(page.getByText('Your cart is empty.')).toBeVisible();
  });
});

test.describe('other locales', () => {
  test('works end to end in Arabic', async ({ page }) => {
    await page.goto('/ar/products/anker-usb-c-cable-2m');
    await page.getByRole('button', { name: 'أضف إلى السلة' }).click();
    // Same race as the English helper: wait for the post to land before moving.
    await expect(page.getByText(/في السلة/)).toBeVisible();

    await page.goto('/ar/cart');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('السلة');
    await expect(lines(page)).toHaveCount(1);
  });

  test('keeps the customer in their locale after a form post', async ({ page }) => {
    await page.goto('/fr/products/anker-usb-c-cable-2m');
    await page.getByRole('button', { name: 'Ajouter au panier' }).click();

    await expect(page.getByText(/dans le panier/)).toBeVisible();
    await expect(page).toHaveURL(/\/fr\/products\//);
  });
});

test.describe('the site header', () => {
  test('links to the catalogue and the cart from every page', async ({ page }) => {
    await page.goto('/en');

    // Scoped to the header's own nav: the footer links to Products too, so an
    // unscoped role query matches both and fails strict mode. This test is
    // about the header, so it should say so.
    const primary = page.getByRole('navigation', { name: 'Primary' });
    await expect(primary).toBeVisible();
    await expect(primary.getByRole('link', { name: 'Products' })).toBeVisible();
    await expect(cartLink(page)).toBeVisible();
  });

  test('offers a skip link as the first thing a keyboard reaches', async ({ page }) => {
    await page.goto('/en/products');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  });
});

test.describe('accessibility', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`the cart has no WCAG 2.1 AA violations in ${locale}`, async ({ page }) => {
      await page.goto(`/${locale}/products/anker-usb-c-cable-2m`);
      await page.getByRole('button', { name: /Add to cart|أضف إلى السلة/ }).click();
      await page.goto(`/${locale}/cart`);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      if (results.violations.length > 0) console.log(JSON.stringify(results.violations, null, 2));
      expect(results.violations).toEqual([]);
    });
  }
});
