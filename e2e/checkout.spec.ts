import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Checkout, end to end.
 *
 * These place REAL orders against the e2e database. That is fine and nothing
 * else asserts on the orders collection — but they also take stock, so anything
 * that needs a specific stock level sets it up itself rather than assuming.
 */

const fill = async (
  page: Page,
  overrides: Partial<
    Record<'name' | 'phone' | 'city' | 'street' | 'notes' | 'region', string>
  > = {},
) => {
  await page.getByLabel('Full name').fill(overrides.name ?? 'Rana K');
  await page.getByLabel('Phone number').fill(overrides.phone ?? '03 123 456');
  await page.getByLabel('Governorate').selectOption(overrides.region ?? 'beirut');
  await page.getByLabel('Town or city').fill(overrides.city ?? 'Beirut');
  await page.getByLabel('Street, building, floor').fill(overrides.street ?? 'Hamra St, Bldg 4');
  if (overrides.notes !== undefined) {
    await page.getByLabel(/Notes for the driver/).fill(overrides.notes);
  }
};

const addToCart = async (page: Page, slug: string) => {
  await page.goto(`/en/products/${slug}`);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByText(/in cart/)).toBeVisible();
};

/**
 * Submit, and wait for the post to land.
 *
 * Clicking a form's submit button returns before the redirect is followed, so a
 * test that read page.url() straight afterwards would read the URL of the page
 * it just left.
 */
const submit = async (page: Page) => {
  await page.getByRole('button', { name: /Place order/ }).click();
  await page.waitForURL(/\/checkout(\/T4T-|\?)/);
};

/**
 * Scoped to <main>: Next renders its own route announcer as role="alert"
 * outside the page content, so an unscoped getByRole('alert') matches two.
 */
const alert = (page: Page) => page.locator('main').getByRole('alert');

test.describe('the checkout form', () => {
  test('is reachable from the cart', async ({ page }) => {
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/cart');
    await page.getByRole('link', { name: 'Checkout' }).click();

    await expect(page).toHaveURL(/\/en\/checkout$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Checkout');
  });

  test('says an empty cart is empty rather than showing a form', async ({ page }) => {
    await page.goto('/en/checkout');
    await expect(page.getByText('Your cart is empty.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Place order/ })).toHaveCount(0);
  });

  test('quotes the same total the order will be written with', async ({ page }) => {
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');

    const summary = page.getByRole('complementary', { name: 'Your order' });
    await expect(summary).toContainText('$19.00');
  });

  test('says plainly that nothing is charged now', async ({ page }) => {
    // The customer should know before they press the button, not after.
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');

    await expect(page.getByText(/pay the driver in cash/i)).toBeVisible();
  });

  test('is kept out of the search index', async ({ page }) => {
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });
});

test.describe('placing an order', () => {
  test('confirms with a number, and empties the cart', async ({ page }) => {
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');
    await fill(page);
    await submit(page);

    // The token comes with it: the order number alone no longer opens this page.
    await expect(page).toHaveURL(/\/en\/checkout\/T4T-\d{2}-\d{6}\?t=[0-9A-HJKMNP-TV-Z]{26}$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Thank you');

    // The cart is cleared only AFTER the order is safely written.
    await page.goto('/en/cart');
    await expect(page.getByText('Your cart is empty.')).toBeVisible();
  });

  test('shows the order number in a form that survives being read aloud', async ({ page }) => {
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');
    await fill(page);
    await submit(page);

    const number = await page.locator('main .font-mono').first().textContent();
    expect(number).toMatch(/^T4T-\d{2}-\d{6}$/);
  });

  test('records what was ordered, and where it goes', async ({ page }) => {
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');
    await fill(page, { notes: 'Ring twice' });
    await submit(page);

    const summary = page.getByRole('region', { name: 'Your order' });
    await expect(summary).toContainText('Anker');
    await expect(summary).toContainText('Rana K');
    await expect(summary).toContainText('Hamra St, Bldg 4');
    await expect(summary).toContainText('Beirut');
    await expect(summary).toContainText('Ring twice');
  });

  test('normalises the phone number the customer typed', async ({ page }) => {
    // The phone number is the customer identity: "03 123 456" and
    // "+961 3 123 456" must be one customer, not two.
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');
    await fill(page, { phone: '03 123 456' });
    await submit(page);

    await expect(page.locator('main')).toContainText('+961 3 123 456');
  });

  test('can be reloaded and shared', async ({ page }) => {
    // There are no accounts; this URL is the only handle the customer has on
    // their order, so it has to survive a refresh and a paste into WhatsApp.
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');
    await fill(page);
    await submit(page);

    const url = page.url();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Thank you');

    await page.goto(url);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Thank you');
  });

  test('404s on an order number that does not exist', async ({ page }) => {
    const response = await page.goto('/en/checkout/T4T-99-999999');
    expect(response?.status()).toBe(404);
  });

  test('cannot be opened by anyone who merely counts to the order number', async ({ page }) => {
    /*
     * Order numbers are sequential, and this page carries a name, a phone
     * number and a street address. The token in the URL is what separates the
     * customer from a stranger working through T4T-26-000001 upwards.
     */
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');
    await fill(page);
    await submit(page);

    const url = new URL(page.url());
    expect(url.searchParams.get('t'), 'no token was issued at all').toMatch(
      /^[0-9A-HJKMNP-TV-Z]{26}$/,
    );

    // The same order, without the token.
    const bare = await page.goto(url.pathname);
    expect(bare?.status()).toBe(404);

    // And with a token of the right shape that is simply not this order's.
    const wrong = await page.goto(`${url.pathname}?t=${'0'.repeat(26)}`);
    expect(wrong?.status()).toBe(404);
  });

  test('a real order with a wrong token is indistinguishable from no order', async ({ page }) => {
    /*
     * Both 404. A 403 on the real one would confirm that T4T-26-000042 exists,
     * which is the single fact enumeration is after — and would make this page
     * an oracle for how many orders the shop has taken.
     */
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');
    await fill(page);
    await submit(page);

    const real = new URL(page.url()).pathname;
    const wrongToken = `?t=${'0'.repeat(26)}`;

    const existing = await page.goto(`${real}${wrongToken}`);
    const invented = await page.goto(`/en/checkout/T4T-99-999998${wrongToken}`);

    expect(existing?.status()).toBe(invented?.status());
    expect(await page.getByRole('heading', { level: 1 }).textContent()).toBeTruthy();
  });
});

test.describe('refusing to place one', () => {
  test('refuses a phone number it cannot read, and keeps everything else typed', async ({
    page,
  }) => {
    // A refused checkout that empties the form is a customer who gives up.
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');
    await fill(page, { phone: 'call me' });
    await submit(page);

    await expect(alert(page)).toContainText(/phone number/i);
    await expect(page.getByLabel('Full name')).toHaveValue('Rana K');
    await expect(page.getByLabel('Town or city')).toHaveValue('Beirut');
  });

  test('refuses a non-Lebanese number', async ({ page }) => {
    // This shop delivers to Lebanon. A number it cannot call is worse than an
    // empty field, which at least reads as missing.
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');
    await fill(page, { phone: '+44 20 7123 4567' });
    await submit(page);

    await expect(alert(page)).toBeVisible();
  });

  test('keeps the cart when a checkout is refused', async ({ page }) => {
    // The worst possible moment to lose a cart is the moment an order failed.
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');
    await fill(page, { phone: 'nope' });
    await submit(page);

    await page.goto('/en/cart');
    await expect(page.locator('main ul > li')).toHaveCount(1);
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('places a whole order from the product page onwards', async ({ page }) => {
    /*
     * The path that matters most on a slow connection: every step is a plain
     * form post, so a customer whose JavaScript has not arrived can still buy
     * something.
     */
    await page.goto('/en/products/anker-usb-c-cable-2m');
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByText(/in cart/)).toBeVisible();

    await page.goto('/en/checkout');
    await fill(page);
    await submit(page);

    await expect(page).toHaveURL(/\/en\/checkout\/T4T-/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Thank you');
  });
});

test.describe('other locales', () => {
  test('orders in Arabic, right to left', async ({ page }) => {
    await page.goto('/ar/products/anker-usb-c-cable-2m');
    await page.getByRole('button', { name: 'أضف إلى السلة' }).click();
    await expect(page.getByText(/في السلة/)).toBeVisible();

    await page.goto('/ar/checkout');
    await page.getByLabel('الاسم الكامل').fill('رنا');
    await page.getByLabel('رقم الهاتف').fill('03 123 456');
    await page.getByLabel('المحافظة').selectOption('beirut');
    await page.getByLabel('البلدة أو المدينة').fill('بيروت');
    await page.getByLabel('الشارع، المبنى، الطابق').fill('شارع الحمرا');
    await page.getByRole('button', { name: /تأكيد الطلب/ }).click();

    await expect(page).toHaveURL(/\/ar\/checkout\/T4T-/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});

test.describe('accessibility', () => {
  test('the checkout form has no WCAG 2.1 AA violations', async ({ page }) => {
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    if (results.violations.length > 0) console.log(JSON.stringify(results.violations, null, 2));
    expect(results.violations).toEqual([]);
  });

  test('the confirmation has no WCAG 2.1 AA violations', async ({ page }) => {
    await addToCart(page, 'anker-usb-c-cable-2m');
    await page.goto('/en/checkout');
    await fill(page);
    await submit(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    if (results.violations.length > 0) console.log(JSON.stringify(results.violations, null, 2));
    expect(results.violations).toEqual([]);
  });
});
