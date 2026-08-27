import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { ADMIN_PASSWORD } from '../playwright.config';

/**
 * The store settings screen, end to end.
 *
 * These edit the ONE settings document the whole shop reads, so every test that
 * changes something puts it back in a `finally`. The window in between is why
 * this file is serial: two of these running at once would each restore a value
 * the other was still asserting on.
 */

const SEEDED = {
  name: 'Taz4Tech',
  phone: '+961 70 000 000',
  vat: '11.00',
  fee: '0.00',
} as const;

/** English, as the admin screen labels them. Beirut first, then north to south. */
const GOVERNORATES = [
  'Beirut',
  'Mount Lebanon',
  'North',
  'Akkar',
  'Bekaa',
  'Baalbek-Hermel',
  'South',
  'Nabatieh',
] as const;

/** Set every governorate to the same amount. */
const setEveryFee = async (page: Page, amount: string) => {
  for (const name of GOVERNORATES) await page.getByLabel(`${name} (USD)`).fill(amount);
};

const signIn = async (page: Page) => {
  await page.goto('/admin/login');
  if (!page.url().includes('/admin/login')) return;

  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible();
};

const openSettings = async (page: Page) => {
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
};

/** Submit, and wait for the redirect that ends the post. */
const save = async (page: Page) => {
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.waitForURL(/[?&](saved|error)=/);
};

/**
 * Put the seeded values back, whatever the test did.
 *
 * Not a fixture teardown: the restore itself goes through the form, so a broken
 * save would fail the test rather than quietly leaving the shop misconfigured
 * for every spec that runs afterwards.
 */
const restore = async (page: Page) => {
  await openSettings(page);
  await page.getByLabel('Shop name').fill(SEEDED.name);
  await page.getByLabel('Contact phone').fill(SEEDED.phone);
  await page.getByLabel('Commercial registry number').fill('');
  await page.getByLabel('VAT rate (%)').fill(SEEDED.vat);
  await setEveryFee(page, SEEDED.fee);
  await save(page);
  await expect(status(page)).toContainText('Saved');
};

const alert = (page: Page) => page.locator('main').getByRole('alert');
const status = (page: Page) => page.locator('main').getByRole('status');

test.describe.configure({ mode: 'serial' });

test.describe('the settings screen', () => {
  test('needs a session, like every other admin page', async ({ page }) => {
    await page.goto('/admin/settings');
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('shows what is stored', async ({ page }) => {
    await signIn(page);
    await openSettings(page);

    await expect(page.getByLabel('Shop name')).toHaveValue(SEEDED.name);
    // Rendered in the shape it is stored in, which is the shape it reads back as.
    await expect(page.getByLabel('VAT rate (%)')).toHaveValue(SEEDED.vat);
    // One box per governorate, all eight, no default and no gaps.
    for (const name of GOVERNORATES) {
      await expect(page.getByLabel(`${name} (USD)`)).toHaveValue(SEEDED.fee);
    }
  });

  test('is reachable from every other admin screen', async ({ page }) => {
    await signIn(page);
    for (const from of ['/admin/products', '/admin/orders', '/admin/import']) {
      await page.goto(from);
      await page.getByRole('link', { name: 'Settings' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    }
  });

  test('does not link to the screen it is already on', async ({ page }) => {
    await signIn(page);
    await openSettings(page);

    const nav = page.getByRole('navigation', { name: 'Admin' });
    await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await expect(nav.getByText('Settings')).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('what the deploy decides', () => {
  test('is shown, but not as something to type in', async ({ page }) => {
    /*
     * The point of the whole panel. A box that accepts an edit and changes
     * nothing is worse than no box: the operator believes they changed
     * something, and nobody finds out until a customer does.
     */
    await signIn(page);
    await openSettings(page);

    const panel = page.getByRole('region', { name: 'Set by the deploy' });
    await expect(panel).toContainText('taz4tech');
    await expect(panel).toContainText('en · ar · fr');
    await expect(panel.locator('input')).toHaveCount(0);

    // And no editable field for them anywhere else on the page either.
    await expect(page.locator('main input[name="siteUrl"]')).toHaveCount(0);
    await expect(page.locator('main input[name="locales"]')).toHaveCount(0);
  });
});

test.describe('editing what customers see', () => {
  test('changes the shop name on the storefront', async ({ page }) => {
    await signIn(page);
    try {
      await openSettings(page);
      await page.getByLabel('Shop name').fill('Taz4Tech Electronics');
      await save(page);

      await expect(status(page)).toContainText('Saved');
      await expect(page.getByLabel('Shop name')).toHaveValue('Taz4Tech Electronics');

      await page.goto('/en');
      await expect(page.locator('main')).toContainText('Taz4Tech Electronics');
    } finally {
      await restore(page);
    }
  });

  test('normalises the phone number, however it was typed', async ({ page }) => {
    // The shop's own number goes through the same door as a customer's.
    await signIn(page);
    try {
      await openSettings(page);
      await page.getByLabel('Contact phone').fill('03 123 456');
      await save(page);

      await expect(page.getByLabel('Contact phone')).toHaveValue('+9613123456');
    } finally {
      await restore(page);
    }
  });

  test('shows a registry number once there is one, and hides the line while there is not', async ({
    page,
  }) => {
    // Law 81/2018 Art. 31 — and an empty label is not compliance, it is clutter.
    await signIn(page);
    try {
      await page.goto('/en');
      await expect(page.locator('main')).not.toContainText('Commercial registry');

      await openSettings(page);
      await page.getByLabel('Commercial registry number').fill('CR-12345');
      await save(page);

      await page.goto('/en');
      await expect(page.locator('main')).toContainText('CR-12345');
    } finally {
      await restore(page);
    }

    await page.goto('/en');
    await expect(page.locator('main')).not.toContainText('Commercial registry');
  });
});

test.describe('delivery, by governorate', () => {
  test('charges what the governorate costs, not what Beirut costs', async ({ page }) => {
    /*
     * The field that costs money, and the whole point of pricing it per region.
     * Everything else on the settings screen changes what a customer reads; this
     * changes what they pay, so it is followed all the way to a placed order.
     */
    await signIn(page);
    try {
      await openSettings(page);
      // A base everywhere, then the two that differ, so the cheapest in the
      // table is Beirut's $2.00 rather than a governorate still left free.
      await setEveryFee(page, '3.00');
      await page.getByLabel('Beirut (USD)').fill('2.00');
      await page.getByLabel('Akkar (USD)').fill('8.00');
      await save(page);
      await expect(status(page)).toContainText('Saved');

      await page.goto('/en/products/anker-usb-c-cable-2m');
      await page.getByRole('button', { name: 'Add to cart' }).click();
      await expect(page.getByText(/in cart/)).toBeVisible();

      await page.goto('/en/checkout');

      // The price is IN the dropdown: no JavaScript, and the cost is in front of
      // the customer at the moment they choose where they live.
      const governorate = page.getByLabel('Governorate');
      await expect(governorate).toContainText('Beirut — $2.00');
      await expect(governorate).toContainText('Akkar — $8.00');

      // Nothing is quoted as exact, because nothing has been chosen yet.
      const summary = page.getByRole('complementary', { name: 'Your order' });
      await expect(summary).toContainText('By governorate');
      await expect(summary).toContainText('From $21.00');

      await page.getByLabel('Full name').fill('Rana K');
      await page.getByLabel('Phone number').fill('03 123 456');
      await governorate.selectOption('akkar');
      await page.getByLabel('Town or city').fill('Halba');
      await page.getByLabel('Street, building, floor').fill('Main St');
      await page.getByRole('button', { name: /Place order/ }).click();
      await page.waitForURL(/\/en\/checkout\/T4T-/);

      // $19.00 of cable plus Akkar's $8.00 — not Beirut's $2.00, and not a
      // number the checkout page guessed before it knew.
      await expect(page.locator('main')).toContainText('$8.00');
      await expect(page.locator('main')).toContainText('$27.00');
    } finally {
      await restore(page);
    }
  });

  test('quotes an exact total when every governorate costs the same', async ({ page }) => {
    // A flat rate is a table with eight equal rows. There is one honest number,
    // so the summary says it rather than hedging.
    await signIn(page);
    try {
      await openSettings(page);
      await setEveryFee(page, '3.00');
      await save(page);

      await page.goto('/en/products/anker-usb-c-cable-2m');
      await page.getByRole('button', { name: 'Add to cart' }).click();
      await expect(page.getByText(/in cart/)).toBeVisible();

      await page.goto('/en/checkout');
      const summary = page.getByRole('complementary', { name: 'Your order' });
      await expect(summary).toContainText('$3.00');
      await expect(summary).toContainText('$22.00');
      await expect(summary).not.toContainText('From');

      // And no prices cluttering the dropdown, because they are all the same.
      // (The em dash cannot be the check: the empty first option is one.)
      await expect(page.getByLabel('Governorate')).not.toContainText('$');
    } finally {
      await restore(page);
    }
  });

  test('reads back as free when every governorate is zero', async ({ page }) => {
    await signIn(page);
    await page.goto('/en/products/anker-usb-c-cable-2m');
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByText(/in cart/)).toBeVisible();

    await page.goto('/en/checkout');
    await expect(page.getByRole('complementary', { name: 'Your order' })).toContainText('Free');
  });
});

test.describe('refusing a change', () => {
  const refusal = async (page: Page, label: string, value: string, expected: RegExp) => {
    await openSettings(page);
    await page.getByLabel(label).fill(value);
    // Something typed in another box too, to prove nothing else is lost.
    await page.getByLabel('Shop name').fill('Half Typed');
    await save(page);

    await expect(alert(page)).toContainText(expected);
    await expect(page.getByLabel('Shop name')).toHaveValue('Half Typed');
    await expect(page.getByLabel(label)).toHaveValue(value);
  };

  test('refuses a phone number it cannot read, and keeps everything typed', async ({ page }) => {
    // A settings form that empties itself because one field was wrong is a form
    // nobody fills in twice.
    await signIn(page);
    await refusal(page, 'Contact phone', 'call the shop', /phone number/i);

    // And nothing was written: a reload shows the stored values again.
    await openSettings(page);
    await expect(page.getByLabel('Shop name')).toHaveValue(SEEDED.name);
  });

  test('refuses a VAT rate above 100%', async ({ page }) => {
    await signIn(page);
    await refusal(page, 'VAT rate (%)', '150', /VAT rate/i);
  });

  test('refuses a VAT rate written ambiguously', async ({ page }) => {
    // "11,5" is eleven and a half to a French writer. Nothing in the box says so.
    await signIn(page);
    await refusal(page, 'VAT rate (%)', '11,5', /VAT rate/i);
  });

  test('refuses a negative delivery fee', async ({ page }) => {
    // A discount nobody asked for, applied to every order going to Bekaa.
    await signIn(page);
    await refusal(page, 'Bekaa (USD)', '-2.00', /delivery fee/i);
  });

  test('writes nothing when one governorate out of eight is wrong', async ({ page }) => {
    // All or nothing. Saving seven prices and refusing the eighth would leave
    // the shop charging a mixture of what the operator meant and what it was.
    await signIn(page);
    await openSettings(page);
    await page.getByLabel('South (USD)').fill('4.00');
    await page.getByLabel('Nabatieh (USD)').fill('gratis');
    await save(page);

    await expect(alert(page)).toBeVisible();
    await openSettings(page);
    await expect(page.getByLabel('South (USD)')).toHaveValue(SEEDED.fee);
  });

  test('refuses an empty shop name', async ({ page }) => {
    await signIn(page);
    await openSettings(page);
    // `required` would stop the browser submitting an empty box, so the server
    // side is reached with spaces — which is the same emptiness with a disguise.
    await page.getByLabel('Shop name').fill('   ');
    await save(page);

    await expect(alert(page)).toContainText(/name/i);
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('saves a change from a plain form post', async ({ page }) => {
    await signIn(page);
    try {
      await openSettings(page);
      await page.getByLabel('Shop name').fill('No Script Shop');
      await save(page);

      await expect(status(page)).toContainText('Saved');
      await expect(page.getByLabel('Shop name')).toHaveValue('No Script Shop');
    } finally {
      await restore(page);
    }
  });
});

test.describe('accessibility', () => {
  test('the settings screen has no WCAG 2.1 AA violations', async ({ page }) => {
    await signIn(page);
    await openSettings(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    if (results.violations.length > 0) console.log(JSON.stringify(results.violations, null, 2));
    expect(results.violations).toEqual([]);
  });

  test('a refused save has no WCAG 2.1 AA violations either', async ({ page }) => {
    // The state with the aria-invalid attributes and the alert on it — which is
    // the state an audit is most likely to skip and a user most likely to hit.
    await signIn(page);
    await openSettings(page);
    await page.getByLabel('Contact phone').fill('nope');
    await save(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    if (results.violations.length > 0) console.log(JSON.stringify(results.violations, null, 2));
    expect(results.violations).toEqual([]);
  });
});
