import { expect, type Page, test } from '@playwright/test';
import { ADMIN_PASSWORD } from '../playwright.config';
import { xlsxUpload } from './support/workbook';

/**
 * Stock, end to end: it arrives through the importer and the storefront tells
 * the truth about it.
 *
 * Everything created here is a DRAFT under its own brand, so the storefront
 * specs that assert exact product counts are unaffected — except where a test
 * genuinely needs a product on sale, which is called out where it happens.
 */

const HEADERS = ['SKU', 'Title', 'Price', 'Brand', 'Status', 'Stock'] as const;
const BRAND = 'Stockbrand';

const unique = () => `Zzstock${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;

const signIn = async (page: Page) => {
  await page.goto('/admin/login');
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible();
};

/**
 * Import a sheet and commit it.
 *
 * `products` is separate from the row count on purpose: rows sharing a title are
 * ONE product with several variants, which is how a real price list is shaped.
 */
const importSheet = async (
  page: Page,
  rows: readonly (readonly string[])[],
  options: { headers?: readonly string[]; products?: number } = {},
) => {
  const headers = options.headers ?? HEADERS;
  const products = options.products ?? rows.length;

  await page.goto('/admin/import');
  await page
    .getByLabel('Catalogue spreadsheet (.xlsx)')
    .setInputFiles(await xlsxUpload('stock.xlsx', [headers, ...rows]));
  await page.getByRole('button', { name: new RegExp(`^Import ${products} product`) }).click();
  await expect(page.locator('main').getByRole('status')).toContainText('Imported');
};

const receipt = (page: Page) => page.locator('main').getByRole('status');

test.describe.configure({ mode: 'serial' });

test.describe('importing stock', () => {
  test('sets a level from the Stock column and says so', async ({ page }) => {
    const title = unique();
    await signIn(page);
    await importSheet(page, [
      [`ST-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft', '4'],
    ]);

    await expect(receipt(page)).toContainText('set stock on 1 SKU');
  });

  test('shows the level in the preview before anything is written', async ({ page }) => {
    const title = unique();
    const sku = `SP-${crypto.randomUUID().slice(0, 8)}`;

    await signIn(page);
    await page.goto('/admin/import');
    await page
      .getByLabel('Catalogue spreadsheet (.xlsx)')
      .setInputFiles(
        await xlsxUpload('stock.xlsx', [HEADERS, [sku, title, '19.99', BRAND, 'draft', '4']]),
      );

    const preview = page.getByRole('table', { name: 'Products in this import' });
    await expect(preview).toContainText(`${sku}: 4`);
    // Still a preview: nothing has been written.
    await expect(receipt(page)).toHaveCount(0);
  });

  test('leaves a blank Stock cell uncounted rather than setting zero', async ({ page }) => {
    /*
     * The distinction the whole column rests on. "I did not count this" and
     * "there are none" are different claims, and importing the first as the
     * second would take a catalogue off sale on the strength of an empty column.
     */
    const title = unique();
    await signIn(page);
    await importSheet(page, [
      [`SB-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft', ''],
    ]);

    await expect(receipt(page)).toContainText('Imported 1 product.');
    await expect(receipt(page)).not.toContainText('set stock');
  });

  test('refuses a quantity it cannot read, naming the row', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/import');
    await page
      .getByLabel('Catalogue spreadsheet (.xlsx)')
      .setInputFiles(
        await xlsxUpload('stock.xlsx', [
          HEADERS,
          [`SX-${crypto.randomUUID().slice(0, 8)}`, unique(), '19.99', BRAND, 'draft', 'a few'],
        ]),
      );

    const problems = page.getByRole('table', { name: 'Problems found, by spreadsheet row' });
    await expect(problems).toContainText('Stock');
    await expect(problems).toContainText('is not a whole number');
  });
});

test.describe('the storefront tells the truth about stock', () => {
  /*
   * These need products a CUSTOMER can see, so they are active — and therefore
   * visible to the listing specs that assert exact counts. They are archived
   * again at the end of each test for that reason.
   */
  const publishThenArchive = async (
    page: Page,
    rows: readonly (readonly string[])[],
    token: string,
    check: () => Promise<void>,
    sheet: { headers?: readonly string[]; products?: number } = {},
  ) => {
    await signIn(page);
    await importSheet(page, rows, sheet);

    await page.goto(`/admin/products?q=${encodeURIComponent(token)}`);
    await page.getByLabel('Select every product on this page').check();
    await page.getByLabel('Change', { exact: true }).selectOption('set_status');
    await page.getByLabel('To', { exact: true }).selectOption('active');
    await page.getByRole('button', { name: /^Check/ }).click();
    await page.getByRole('button', { name: /^Apply/ }).click();
    await expect(receipt(page)).toContainText('Updated');

    try {
      await check();
    } finally {
      await page.goto(`/admin/products?q=${encodeURIComponent(token)}`);
      await page.getByLabel('Select every product on this page').check();
      await page.getByLabel('Change', { exact: true }).selectOption('set_status');
      await page.getByLabel('To', { exact: true }).selectOption('archived');
      await page.getByRole('button', { name: /^Check/ }).click();
      await page.getByRole('button', { name: /^Apply/ }).click();
      await expect(receipt(page)).toContainText('Updated');
    }
  };

  test('says out of stock on the product page when the count is zero', async ({ page }) => {
    const title = unique();
    const slug = title.toLowerCase();

    await publishThenArchive(
      page,
      [[`SO-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft', '0']],
      title,
      async () => {
        await page.goto(`/en/products/${slug}`);
        await expect(page.locator('main').getByRole('status')).toContainText('Out of stock');
      },
    );
  });

  test('says in stock, and how few, when the count is low', async ({ page }) => {
    // "Only 2 left" is a real nudge AND a true statement. "Only 47 left" is
    // neither, which is why the count only appears below a threshold.
    const title = unique();
    const slug = title.toLowerCase();

    await publishThenArchive(
      page,
      [[`SL-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft', '2']],
      title,
      async () => {
        await page.goto(`/en/products/${slug}`);
        const status = page.locator('main').getByRole('status');
        await expect(status).toContainText('In stock');
        await expect(status).toContainText('Only 2 left');
      },
    );
  });

  test('shows no count at all for an uncounted SKU', async ({ page }) => {
    // Nothing honest to say, so it says nothing — rather than "In stock (0)".
    const title = unique();
    const slug = title.toLowerCase();

    await publishThenArchive(
      page,
      [[`SU-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft', '']],
      title,
      async () => {
        await page.goto(`/en/products/${slug}`);
        const status = page.locator('main').getByRole('status');
        await expect(status).toContainText('In stock');
        await expect(status).not.toContainText('left');
      },
    );
  });

  test('badges a sold-out product on the listing and in the quick view', async ({ page }) => {
    const title = unique();

    await publishThenArchive(
      page,
      [[`SG-${crypto.randomUUID().slice(0, 8)}`, title, '19.99', BRAND, 'draft', '0']],
      title,
      async () => {
        await page.goto(`/en/products?q=${encodeURIComponent(title)}`);

        const tile = page.locator('main ul li').filter({ hasText: title });
        await expect(tile).toContainText('Out of stock');

        await tile.getByRole('link', { name: 'Quick view' }).click();
        await expect(page.getByRole('dialog')).toContainText('Out of stock');
      },
    );
  });

  test('keeps a product buyable while any variant remains', async ({ page }) => {
    /*
     * Sold out only when EVERY variant is. A product with one size left is
     * still a product the customer can buy, and badging the tile would lose the
     * sale that was still there.
     */
    const title = unique();
    const stamp = crypto.randomUUID().slice(0, 8);

    await publishThenArchive(
      page,
      [
        [`SV1-${stamp}`, title, '19.99', BRAND, 'draft', '0', 'Size', 'Small'],
        [`SV2-${stamp}`, title, '24.99', BRAND, 'draft', '5', 'Size', 'Large'],
      ],
      title,
      async () => {
        await page.goto(`/en/products?q=${encodeURIComponent(title)}`);
        const tile = page.locator('main ul li').filter({ hasText: title });
        await expect(tile).not.toContainText('Out of stock');

        // And the dialog tells the per-variant truth the tile cannot.
        await tile.getByRole('link', { name: 'Quick view' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('In stock');
        await dialog.getByRole('button', { name: 'Small' }).click();
        await expect(dialog).toContainText('Out of stock');
      },
      // Two rows sharing a title are ONE product with two variants.
      { headers: [...HEADERS, 'Option1 Name', 'Option1 Value'], products: 1 },
    );
  });
});
