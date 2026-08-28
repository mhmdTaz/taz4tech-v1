import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { ADMIN_PASSWORD } from '../playwright.config';
import { xlsxUpload } from './support/workbook';

/**
 * The admin order screens, end to end.
 *
 * Every order here is a REAL one, placed through the storefront, because the
 * thing worth proving is that what checkout writes is what the operator reads —
 * a fixture inserted straight into Mongo would prove the screen renders a shape
 * I invented, not the shape the checkout produces.
 */

/**
 * Sign in, or notice that this page already is.
 *
 * /admin/login redirects an existing session to the products screen, so a second
 * call would otherwise look for a password field that is not there.
 */
const signIn = async (page: Page) => {
  await page.goto('/admin/login');
  if (!page.url().includes('/admin/login')) return;

  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible();
};

const CABLE = 'anker-usb-c-cable-2m';

/**
 * Place an order and return its number.
 *
 * Waits for the confirmation URL rather than reading page.url() after the click:
 * clicking a submit button returns before the redirect is followed.
 */
const placeOrder = async (
  page: Page,
  options: { locale?: 'en' | 'ar'; slug?: string; name?: string } = {},
): Promise<string> => {
  const locale = options.locale ?? 'en';
  const slug = options.slug ?? CABLE;

  await page.goto(`/${locale}/products/${slug}`);
  await page
    .getByRole('button', { name: locale === 'ar' ? 'أضف إلى السلة' : 'Add to cart' })
    .click();
  await expect(page.getByText(locale === 'ar' ? /في السلة/ : /in cart/)).toBeVisible();

  await page.goto(`/${locale}/checkout`);

  if (locale === 'ar') {
    await page.getByLabel('الاسم الكامل').fill(options.name ?? 'رنا');
    await page.getByLabel('رقم الهاتف').fill('03 123 456');
    await page.getByLabel('المحافظة').selectOption('beirut');
    await page.getByLabel('البلدة أو المدينة').fill('بيروت');
    await page.getByLabel('الشارع، المبنى، الطابق').fill('شارع الحمرا');
    await page.getByRole('button', { name: /تأكيد الطلب/ }).click();
  } else {
    await page.getByLabel('Full name').fill(options.name ?? 'Rana K');
    await page.getByLabel('Phone number').fill('03 123 456');
    await page.getByLabel('Governorate').selectOption('beirut');
    await page.getByLabel('Town or city').fill('Beirut');
    await page.getByLabel('Street, building, floor').fill('Hamra St, Bldg 4');
    await page.getByLabel(/Notes for the driver/).fill('Ring twice');
    await page.getByRole('button', { name: /Place order/ }).click();
  }

  await page.waitForURL(new RegExp(`/${locale}/checkout/T4T-`));

  const number = (await page.locator('main .font-mono').first().textContent())?.trim() ?? '';
  expect(number).toMatch(/^T4T-\d{2}-\d{6}$/);
  return number;
};

const openOrder = async (page: Page, number: string) => {
  await page.goto(`/admin/orders/${number}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(number);
};

/**
 * Press a transition button and wait for the redirect to land.
 *
 * The outcome comes back as a query parameter, so waiting for one is waiting for
 * the post to have actually happened — clicking returns before the redirect is
 * followed, and asserting on the page in between reads the page it just left.
 */
const move = async (page: Page, label: string) => {
  await page.getByRole('button', { name: label }).click();
  await page.waitForURL(/[?&](moved|conflict)=/);
};

/** Scoped to <main>: Next's route announcer is a role="alert" outside the page. */
const alert = (page: Page) => page.locator('main').getByRole('alert');
const status = (page: Page) => page.locator('main').getByRole('status');

/*
 * Serial, like the other admin specs. The cancellation tests publish a product
 * so it can be bought, and two of those running at once would each archive a
 * catalogue the other is still reading.
 */
test.describe.configure({ mode: 'serial' });

test.describe('the orders list', () => {
  test('needs a session, like every other admin page', async ({ page }) => {
    // Checked on the page itself, not in a layout or middleware — see
    // src/app/admin/session.ts for why that distinction is the whole defence.
    await page.goto('/admin/orders');
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('shows an order the moment it is placed', async ({ page }) => {
    const number = await placeOrder(page);
    await signIn(page);

    await page.goto('/admin/orders');
    const row = page.getByRole('row').filter({ hasText: number });
    await expect(row).toContainText('Rana K');
    await expect(row).toContainText('Pending');
    // The phone in the shape the operator dials, not the shape it is stored in.
    await expect(row).toContainText('+961 3 123 456');
  });

  test('filters by status, and the filter is a URL', async ({ page }) => {
    const number = await placeOrder(page);
    await signIn(page);

    await page.goto('/admin/orders?status=pending');
    await expect(page.getByRole('row').filter({ hasText: number })).toBeVisible();

    // Bookmarkable: a reload of the filtered URL shows the same thing.
    await page.goto('/admin/orders?status=delivered');
    await expect(page.getByRole('row').filter({ hasText: number })).toHaveCount(0);
  });

  test('ignores a status nobody defined rather than breaking', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/orders?status=elephant');
    await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  });

  test('finds a customer by the number they give on the phone', async ({ page }) => {
    /*
     * The phone number IS the customer identity here, so this is a lookup, not a
     * search. The operator types what the customer says — "03 123 456" — and
     * orders store +9613123456, because every one of them went in through the
     * same normaliser. Without normalising the search too, the number on the
     * screen never matches the number in the database.
     */
    const number = await placeOrder(page);
    await signIn(page);

    for (const typed of ['03 123 456', '+961 3 123 456', '03123456']) {
      await page.goto(`/admin/orders?phone=${encodeURIComponent(typed)}`);
      await expect(page.getByRole('row').filter({ hasText: number }), typed).toBeVisible();
    }
  });

  test('says a number is unreadable rather than showing an empty list', async ({ page }) => {
    // "No orders for that number" and "that is not a number" are different
    // sentences, and the operator is on the phone to somebody while they read one.
    await signIn(page);
    await page.goto('/admin/orders?phone=the+guy+from+yesterday');

    await expect(alert(page)).toContainText('is not a phone number');
  });

  test('combines the phone lookup with a status filter', async ({ page }) => {
    const number = await placeOrder(page);
    await signIn(page);

    await page.goto('/admin/orders?phone=03+123+456&status=pending');
    await expect(page.getByRole('row').filter({ hasText: number })).toBeVisible();

    await page.goto('/admin/orders?phone=03+123+456&status=delivered');
    await expect(page.getByRole('row').filter({ hasText: number })).toHaveCount(0);
  });

  test('searches from the form with no JavaScript', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    const number = await placeOrder(page);
    await signIn(page);
    await page.goto('/admin/orders');

    await page.getByLabel('Customer phone').fill('03 123 456');
    await page.getByRole('button', { name: 'Find orders' }).click();

    await expect(page).toHaveURL(/phone=/);
    await expect(page.getByRole('row').filter({ hasText: number })).toBeVisible();
    await context.close();
  });

  test('opens an order from its number', async ({ page }) => {
    const number = await placeOrder(page);
    await signIn(page);

    await page.goto('/admin/orders');
    await page.getByRole('link', { name: number }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(number);
  });

  test('is reachable from the products screen login lands on', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Orders' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  });
});

test.describe('one order', () => {
  test('shows everything needed to pack it and deliver it', async ({ page }) => {
    const number = await placeOrder(page);
    await signIn(page);
    await openOrder(page, number);

    await expect(page.locator('main')).toContainText('Anker');
    await expect(page.locator('main')).toContainText('Rana K');
    await expect(page.locator('main')).toContainText('Hamra St, Bldg 4');
    await expect(page.locator('main')).toContainText('Beirut');
    // The note the driver needs, not buried somewhere else.
    await expect(page.locator('main')).toContainText('Ring twice');
    await expect(page.locator('main')).toContainText('$19.00');
  });

  test('makes the phone number one tap to dial', async ({ page }) => {
    const number = await placeOrder(page);
    await signIn(page);
    await openOrder(page, number);

    const tel = page.locator('main a[href^="tel:"]');
    // E.164 in the href so the dialler gets it right; spaced for the human.
    await expect(tel).toHaveAttribute('href', 'tel:+9613123456');
    await expect(tel).toContainText('+961 3 123 456');
  });

  test('404s on an order number that does not exist', async ({ page }) => {
    await signIn(page);
    const response = await page.goto('/admin/orders/T4T-99-999999');
    expect(response?.status()).toBe(404);
  });
});

test.describe('moving an order along', () => {
  test('confirms, then delivers, and then offers nothing more', async ({ page }) => {
    const number = await placeOrder(page);
    await signIn(page);
    await openOrder(page, number);

    await move(page, 'Confirm');
    await expect(status(page)).toContainText('now confirmed');

    await move(page, 'Mark delivered');
    await expect(status(page)).toContainText('now delivered');

    await expect(page.locator('main')).toContainText('Nothing left to do');
    await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
  });

  test('does not offer a step the lifecycle forbids', async ({ page }) => {
    // Pending goes to confirmed or cancelled. Delivered would skip the phone
    // call the operator makes before anything leaves the shop.
    const number = await placeOrder(page);
    await signIn(page);
    await openOrder(page, number);

    await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel order' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark delivered' })).toHaveCount(0);
  });

  test('carries the status the screen was drawn from', async ({ page }) => {
    // What makes a stale screen answerable. Without it the server can only
    // compare the order against itself and every race looks like a mistake.
    const number = await placeOrder(page);
    await signIn(page);
    await openOrder(page, number);

    const form = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: 'Confirm' }) });
    await expect(form.locator('input[name="from"]')).toHaveValue('pending');
    await expect(form.locator('input[name="to"]')).toHaveValue('confirmed');
  });

  test('tells the operator when somebody else moved it first', async ({ page, context }) => {
    /*
     * Two operators, one order. The second one to press Confirm sees what the
     * order IS now, not a complaint about something they did wrong — the
     * transition was legal when they looked at the screen.
     */
    const number = await placeOrder(page);
    await signIn(page);

    const second = await context.newPage();
    await openOrder(page, number);
    await openOrder(second, number);

    await move(second, 'Confirm');
    await expect(status(second)).toContainText('now confirmed');

    await move(page, 'Confirm');
    await expect(alert(page)).toContainText('Somebody moved this order first');
    await expect(alert(page)).toContainText('confirmed');

    await second.close();
  });
});

test.describe('cancelling', () => {
  const HEADERS = ['SKU', 'Title', 'Price', 'Brand', 'Status', 'Stock'] as const;
  const BRAND = 'Ordersbrand';
  const unique = () => `Zzorder${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;

  /** Import a counted product, publish it, run the test, then archive it again. */
  const withStockedProduct = async (
    page: Page,
    onHand: number,
    check: (slug: string) => Promise<void>,
  ) => {
    const title = unique();
    const slug = title.toLowerCase();

    await signIn(page);
    await page.goto('/admin/import');
    await page
      .getByLabel('Catalogue spreadsheet (.xlsx)')
      .setInputFiles(
        await xlsxUpload('orders.xlsx', [
          HEADERS,
          [`OC-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft', String(onHand)],
        ]),
      );
    await page.getByRole('button', { name: /^Import 1 product/ }).click();
    await expect(status(page)).toContainText('Imported');

    const setStatus = async (to: string) => {
      await page.goto(`/admin/products?q=${encodeURIComponent(title)}`);
      await page.getByLabel('Select every product on this page').check();
      await page.getByLabel('Change', { exact: true }).selectOption('set_status');
      await page.getByLabel('To', { exact: true }).selectOption(to);
      await page.getByRole('button', { name: /^Check/ }).click();
      await page.getByRole('button', { name: /^Apply/ }).click();
      await expect(status(page)).toContainText('Updated');
    };

    await setStatus('active');
    try {
      await check(slug);
    } finally {
      await setStatus('archived');
    }
  };

  test('puts the stock back on the shelf', async ({ page }) => {
    // The reason the whole update is a conditional write: this credit must
    // happen exactly once, and only for the caller whose write won.
    await withStockedProduct(page, 3, async (slug) => {
      const number = await placeOrder(page, { slug });

      await page.goto(`/en/products/${slug}`);
      await expect(status(page)).toContainText('Only 2 left');

      await signIn(page);
      await openOrder(page, number);
      await move(page, 'Cancel order');
      await expect(status(page)).toContainText('stock has gone back');

      await page.goto(`/en/products/${slug}`);
      await expect(status(page)).toContainText('Only 3 left');
    });
  });

  test('does not give it back twice', async ({ page, context }) => {
    await withStockedProduct(page, 3, async (slug) => {
      const number = await placeOrder(page, { slug });
      await signIn(page);

      const second = await context.newPage();
      await openOrder(page, number);
      await openOrder(second, number);

      await move(second, 'Cancel order');
      await move(page, 'Cancel order');
      await expect(alert(page)).toContainText('Somebody moved this order first');
      await second.close();

      // Three, not four. A second credit would invent a unit that never existed.
      await page.goto(`/en/products/${slug}`);
      await expect(status(page)).toContainText('Only 3 left');
    });
  });
});

test.describe('the WhatsApp message', () => {
  test('is a tap-to-send link, addressed to the customer', async ({ page }) => {
    const number = await placeOrder(page);
    await signIn(page);
    await openOrder(page, number);

    const link = page.getByRole('link', { name: 'Send on WhatsApp' });
    const href = (await link.getAttribute('href')) ?? '';

    // Digits only, no plus: wa.me with a plus opens a chat with nobody.
    expect(href).toMatch(/^https:\/\/wa\.me\/9613123456\?text=/);

    const message = decodeURIComponent(href.split('?text=')[1] ?? '');
    expect(message).toContain('Rana K');
    expect(message).toContain(number);
    expect(message).toContain('$19.00');
    expect(message).toContain('cash on delivery');

    // Nothing is sent by this page. The operator presses send in WhatsApp.
    await expect(page.locator('main')).toContainText('You press send');
    await expect(link).toHaveAttribute('rel', /noreferrer/);
  });

  test('is written in the language the customer shopped in', async ({ page }) => {
    /*
     * The order records its locale at checkout, and this is the only place that
     * fact is ever used. A customer who browsed in Arabic gets Arabic back, from
     * an admin screen that is entirely in English.
     */
    const number = await placeOrder(page, { locale: 'ar' });
    await signIn(page);
    await openOrder(page, number);

    const href =
      (await page.getByRole('link', { name: 'Send on WhatsApp' }).getAttribute('href')) ?? '';
    const message = decodeURIComponent(href.split('?text=')[1] ?? '');

    expect(message).toContain('مرحباً');
    expect(message).toContain('نقداً عند الاستلام');
    expect(message).toContain(number);
  });
});

test.describe('accessibility', () => {
  test('the orders list has no WCAG 2.1 AA violations', async ({ page }) => {
    await placeOrder(page);
    await signIn(page);
    await page.goto('/admin/orders');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    if (results.violations.length > 0) console.log(JSON.stringify(results.violations, null, 2));
    expect(results.violations).toEqual([]);
  });

  test('an order has no WCAG 2.1 AA violations', async ({ page }) => {
    const number = await placeOrder(page);
    await signIn(page);
    await openOrder(page, number);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    if (results.violations.length > 0) console.log(JSON.stringify(results.violations, null, 2));
    expect(results.violations).toEqual([]);
  });
});
