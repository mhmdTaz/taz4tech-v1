import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { ADMIN_PASSWORD } from '../playwright.config';
import { xlsxUpload } from './support/workbook';

/**
 * The bulk editor, end to end.
 *
 * Like the importer specs, everything created here is a DRAFT under a brand of
 * its own, so the storefront specs that assert exact product counts are not
 * affected. Products are created through the importer rather than seeded,
 * because that is the only write path the admin has — and it means these tests
 * exercise the two screens together.
 */

const SHEET_HEADERS = ['SKU', 'Title', 'Price', 'Brand', 'Status'] as const;
const BRAND = 'Bulkbrand';

/**
 * A single unique WORD, used both as the product title and as the search term.
 *
 * Not a phrase: search is a text index, so it matches tokens rather than the
 * literal string. "Zz Bulk Draft abc" would also match every other "Zz Bulk"
 * product left over from another test, and selecting all of them would apply the
 * edit to products a different test is asserting about.
 */
const unique = () => `Zzbulk${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;

const signIn = async (page: Page) => {
  await page.goto('/admin/login');
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible();
};

/** Create products via the importer, and return the titles that were made. */
const seedProducts = async (page: Page, rows: readonly (readonly string[])[]): Promise<void> => {
  await page.goto('/admin/import');
  await page
    .getByLabel('Catalogue spreadsheet (.xlsx)')
    .setInputFiles(await xlsxUpload('bulk.xlsx', [SHEET_HEADERS, ...rows]));

  await page.getByRole('button', { name: new RegExp(`^Import ${rows.length} product`) }).click();
  await expect(page.locator('main').getByRole('status')).toContainText('Imported');
};

const openProducts = async (page: Page, query: string) => {
  await page.goto(`/admin/products?q=${encodeURIComponent(query)}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible();
};

const productTable = (page: Page) =>
  page.getByRole('table', { name: 'Products, with a checkbox to select each' });
const changesTable = (page: Page) =>
  page.getByRole('table', { name: 'Products this change affects' });
const alerts = (page: Page) => page.locator('main').getByRole('alert');
const receipt = (page: Page) => page.locator('main').getByRole('status');

/**
 * Exact label matching throughout: the surrounding <section> is named "Apply a
 * change", and a substring match on "Change" would resolve to both it and the
 * select inside it.
 */
const selectAll = async (page: Page) => {
  await page.getByLabel('Select every product on this page').check();
};

test.describe.configure({ mode: 'serial' });

test.describe('the product list', () => {
  test('shows drafts, which the storefront never does', async ({ page }) => {
    const title = unique();
    await signIn(page);
    await seedProducts(page, [
      [`BD-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft'],
    ]);

    await openProducts(page, title);
    const row = productTable(page).getByRole('row').filter({ hasText: title });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('draft');
  });

  test('filters by status through the URL, so a view can be bookmarked', async ({ page }) => {
    const title = unique();
    await signIn(page);
    await seedProducts(page, [
      [`BF-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft'],
    ]);

    await page.goto(`/admin/products?q=${encodeURIComponent(title)}&status=active`);
    await expect(productTable(page).getByText(title)).toHaveCount(0);

    await page.goto(`/admin/products?q=${encodeURIComponent(title)}&status=draft`);
    await expect(productTable(page).getByText(title)).toBeVisible();
  });

  test('a status in the URL cannot leak drafts to the storefront', async ({ page }) => {
    // The single gate, checked from the outside: ?status=draft on a customer URL
    // must not become a draft listing.
    const title = unique();
    await signIn(page);
    await seedProducts(page, [
      [`BL-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft'],
    ]);

    await page.goto(`/en/products?status=draft&q=${encodeURIComponent(title)}`);
    await expect(page.locator('main')).not.toContainText(title);
  });
});

test.describe('previewing a change', () => {
  test('writes nothing until it is applied', async ({ page }) => {
    const title = unique();
    await signIn(page);
    await seedProducts(page, [
      [`BP-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft'],
    ]);
    await openProducts(page, title);

    await selectAll(page);
    await page.getByLabel('Change', { exact: true }).selectOption('scale_price');
    await page.getByLabel('Percent', { exact: true }).fill('10');
    await page.getByRole('button', { name: /^Check 1 selected/ }).click();

    await expect(changesTable(page)).toContainText('$19.99 → $21.99');
    await expect(receipt(page)).toHaveCount(0);

    // Reload: still the old price, because a preview writes nothing.
    await openProducts(page, title);
    await expect(productTable(page)).toContainText('$19.99');
  });

  test('applies what was previewed', async ({ page }) => {
    const title = unique();
    await signIn(page);
    await seedProducts(page, [
      [`BA-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft'],
    ]);
    await openProducts(page, title);

    await selectAll(page);
    await page.getByLabel('Change', { exact: true }).selectOption('scale_price');
    await page.getByLabel('Percent', { exact: true }).fill('10');
    await page.getByRole('button', { name: /^Check 1 selected/ }).click();
    await page.getByRole('button', { name: /^Apply to 1 product/ }).click();

    await expect(receipt(page)).toContainText('Updated 1 product.');

    await openProducts(page, title);
    await expect(productTable(page)).toContainText('$21.99');
  });

  test('rounds a percentage to the cent, half away from zero', async ({ page }) => {
    // $10.00 raised 5% is $10.50 exactly; $0.10 raised 5% is 10.5c, which must
    // become 11c rather than 10c.
    const title = unique();
    await signIn(page);
    await seedProducts(page, [
      [`BR-${crypto.randomUUID().slice(0, 8)}`, title, '0.10', BRAND, 'draft'],
    ]);
    await openProducts(page, title);

    await selectAll(page);
    await page.getByLabel('Change', { exact: true }).selectOption('scale_price');
    await page.getByLabel('Percent', { exact: true }).fill('5');
    await page.getByRole('button', { name: /^Check 1 selected/ }).click();

    await expect(changesTable(page)).toContainText('$0.10 → $0.11');
  });
});

test.describe('status and brand', () => {
  test('changes the status of a batch, and back again', async ({ page }) => {
    /*
     * Archived rather than active, deliberately.
     *
     * The storefront specs assert exact product counts on the listing, and the
     * projects run in parallel — so a product made ACTIVE here would be visible
     * to facets-and-search for as long as this test held it that way, and that
     * suite would fail somewhere else entirely. Archiving exercises the same
     * wiring without ever putting a test fixture in front of a customer.
     *
     * That active products appear on the storefront is already proved by the
     * seeded catalogue; what is unproved until here is that a bulk status change
     * reaches the database at all.
     */
    const token = unique();
    const titles = [`${token} alpha`, `${token} beta`];

    await signIn(page);
    await seedProducts(
      page,
      titles.map((title, i) => [
        `BS-${crypto.randomUUID().slice(0, 8)}-${i}`,
        title,
        '19.99',
        BRAND,
        'draft',
      ]),
    );
    await openProducts(page, token);

    await selectAll(page);
    await page.getByLabel('Change', { exact: true }).selectOption('set_status');
    await page.getByLabel('To', { exact: true }).selectOption('archived');
    await page.getByRole('button', { name: /^Check 2 selected/ }).click();
    await page.getByRole('button', { name: /^Apply to 2 products/ }).click();

    await expect(receipt(page)).toContainText('Updated 2 products.');

    // Reloaded from the database, not from the preview that produced it.
    await openProducts(page, token);
    await expect(
      productTable(page)
        .getByRole('row')
        .filter({ hasText: titles[0] ?? '' }),
    ).toContainText('archived');

    // And back, which is the operation an operator uses to recover a mistake.
    await selectAll(page);
    await page.getByLabel('Change', { exact: true }).selectOption('set_status');
    await page.getByLabel('To', { exact: true }).selectOption('draft');
    await page.getByRole('button', { name: /^Check 2 selected/ }).click();
    await page.getByRole('button', { name: /^Apply to 2 products/ }).click();
    await expect(receipt(page)).toContainText('Updated 2 products.');
  });

  test('says nothing changed when the value already matches', async ({ page }) => {
    // Reported as skipped rather than counted as a change: writing it would move
    // updatedAt for nothing.
    const title = unique();
    await signIn(page);
    await seedProducts(page, [
      [`BN-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft'],
    ]);
    await openProducts(page, title);

    await selectAll(page);
    await page.getByLabel('Change', { exact: true }).selectOption('set_status');
    await page.getByLabel('To', { exact: true }).selectOption('draft');
    await page.getByRole('button', { name: /^Check 1 selected/ }).click();

    await expect(page.getByRole('heading', { name: /^Not changed/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Apply/ })).toHaveCount(0);
  });

  test('sets and clears a brand', async ({ page }) => {
    const title = unique();
    await signIn(page);
    await seedProducts(page, [
      [`BB-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft'],
    ]);
    await openProducts(page, title);

    await selectAll(page);
    await page.getByLabel('Change', { exact: true }).selectOption('set_brand');
    await page.getByLabel('To', { exact: true }).fill('Rebranded');
    await page.getByRole('button', { name: /^Check 1 selected/ }).click();

    await expect(changesTable(page)).toContainText(`${BRAND} → Rebranded`);
  });
});

test.describe('refusing what would be wrong', () => {
  test('refuses a rise that would erase an advertised discount', async ({ page }) => {
    /*
     * The rule this pins: a was-price is a claim about history, so raising the
     * selling price does NOT move it. Raise it far enough and the discount would
     * be zero or negative — a misleading commercial claim — so that product is
     * refused by name rather than written.
     */
    const title = unique();
    await signIn(page);

    await page.goto('/admin/import');
    await page.getByLabel('Catalogue spreadsheet (.xlsx)').setInputFiles(
      await xlsxUpload('offer.xlsx', [
        [...SHEET_HEADERS, 'Compare At Price', 'Offer Ends At'],
        [
          `BO-${crypto.randomUUID().slice(0, 8)}`,
          title,
          '19.99',
          BRAND,
          'draft',
          '20.99',
          '2027-12-31',
        ],
      ]),
    );
    await page.getByRole('button', { name: /^Import 1 product/ }).click();
    await expect(receipt(page)).toContainText('Imported');

    await openProducts(page, title);
    await selectAll(page);
    await page.getByLabel('Change', { exact: true }).selectOption('scale_price');
    await page.getByLabel('Percent', { exact: true }).fill('50');
    await page.getByRole('button', { name: /^Check 1 selected/ }).click();

    await expect(page.getByRole('heading', { name: /^Not changed/ })).toBeVisible();
    await expect(page.locator('main')).toContainText('not above the selling price');
    await expect(page.getByRole('button', { name: /^Apply/ })).toHaveCount(0);
  });

  test('clears the offer, which then allows the rise', async ({ page }) => {
    const title = unique();
    await signIn(page);

    await page.goto('/admin/import');
    await page.getByLabel('Catalogue spreadsheet (.xlsx)').setInputFiles(
      await xlsxUpload('offer.xlsx', [
        [...SHEET_HEADERS, 'Compare At Price', 'Offer Ends At'],
        [
          `BC-${crypto.randomUUID().slice(0, 8)}`,
          title,
          '19.99',
          BRAND,
          'draft',
          '20.99',
          '2027-12-31',
        ],
      ]),
    );
    await page.getByRole('button', { name: /^Import 1 product/ }).click();
    await expect(receipt(page)).toContainText('Imported');

    await openProducts(page, title);
    await selectAll(page);
    await page.getByLabel('Change', { exact: true }).selectOption('clear_offer');
    await page.getByRole('button', { name: /^Check 1 selected/ }).click();
    await page.getByRole('button', { name: /^Apply to 1 product/ }).click();
    await expect(receipt(page)).toContainText('Updated 1 product.');

    await openProducts(page, title);
    await selectAll(page);
    await page.getByLabel('Change', { exact: true }).selectOption('scale_price');
    await page.getByLabel('Percent', { exact: true }).fill('50');
    await page.getByRole('button', { name: /^Check 1 selected/ }).click();

    await expect(changesTable(page)).toContainText('$19.99 → $29.99');
  });

  test('will not check anything with nothing selected', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/products');
    await expect(page.getByRole('button', { name: /^Check 0 selected/ })).toBeDisabled();
  });
});

test.describe('the gate', () => {
  test('sends a signed-out visitor to the login page', async ({ page }) => {
    await page.goto('/admin/products');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test('/admin lands on the product list once signed in', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/products$/);
  });
});

test.describe('accessibility', () => {
  test('the product list has no WCAG 2.1 AA violations', async ({ page }) => {
    const title = unique();
    await signIn(page);
    await seedProducts(page, [
      [`BX-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft'],
    ]);
    await openProducts(page, title);

    // Scanned with a preview on screen, so the change table and the skipped
    // panel are both in the tree.
    await selectAll(page);
    await page.getByLabel('Change', { exact: true }).selectOption('set_status');
    await page.getByLabel('To', { exact: true }).selectOption('active');
    await page.getByRole('button', { name: /^Check 1 selected/ }).click();
    await expect(changesTable(page)).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    if (results.violations.length > 0) console.log(JSON.stringify(results.violations, null, 2));
    expect(results.violations).toEqual([]);
    expect(alerts(page)).toHaveCount(0);
  });
});
