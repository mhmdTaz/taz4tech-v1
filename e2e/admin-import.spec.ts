import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { ADMIN_PASSWORD } from '../playwright.config';
import { xlsxUpload } from './support/workbook';

/**
 * The admin importer, end to end.
 *
 * EVERYTHING IMPORTED HERE IS A DRAFT.
 *
 * The e2e database is shared with the storefront specs, which assert exact
 * product counts on the listing. An active product imported here would fail
 * facets-and-search two files away, and the failure would point at the wrong
 * code. Drafts are invisible to every storefront query, so these tests can write
 * for real without touching anyone else's fixtures.
 *
 * That the write actually happened is proved by re-importing: the second run
 * reports "update" rather than "new", which is only true if the first one
 * persisted.
 */

const HEADERS = ['SKU', 'Title', 'Price', 'Brand', 'Status'] as const;

/**
 * Unique per run, per retry AND per browser project.
 *
 * Both projects run the same specs against one database. A fixed SKU would make
 * the desktop and mobile runs fight over it — and lose in exactly the way the
 * conflict detection now describes, which is a confusing way for a test suite to
 * demonstrate that the feature works.
 */
const unique = () => crypto.randomUUID().slice(0, 8);
const uniqueTitle = () => `Zz Fixture ${unique()}`;
const uniqueSku = (prefix: string) => `${prefix}-${unique()}`;

const signIn = async (page: Page) => {
  await page.goto('/admin/login');
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Import catalogue' })).toBeVisible();
};

const upload = async (page: Page, rows: readonly (readonly string[])[]) => {
  await page
    .getByLabel('Catalogue spreadsheet (.xlsx)')
    .setInputFiles(await xlsxUpload('catalogue.xlsx', rows));
};

/**
 * Scoped to <main> on purpose.
 *
 * Next renders its own route announcer as role="alert" outside the page content,
 * so an unscoped getByRole('alert') matches two elements and Playwright's strict
 * mode rejects it. Scoping also states what is actually meant: an alert THIS
 * PAGE raised, not one the framework did.
 */
const alerts = (page: Page) => page.locator('main').getByRole('alert');
const receipt = (page: Page) => page.locator('main').getByRole('status');

const previewTable = (page: Page) => page.getByRole('table', { name: 'Products in this import' });
const problemsTable = (page: Page) =>
  page.getByRole('table', { name: 'Problems found, by spreadsheet row' });

test.describe('the admin gate', () => {
  test('sends a signed-out visitor to the login page', async ({ page }) => {
    await page.goto('/admin/import');
    await expect(page).toHaveURL(/\/admin\/login$/);
    await expect(page.getByLabel('Password')).toBeVisible();
  });

  test('sends /admin to the same place when signed out', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test('refuses a wrong password without saying anything useful', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(alerts(page)).toHaveText('Wrong password.');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test('lets the right password through', async ({ page }) => {
    await signIn(page);
    await expect(page).toHaveURL(/\/admin\/import$/);
  });

  test('signing out closes the door again', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/admin\/login$/);

    await page.goto('/admin/import');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test('is never offered to a crawler', async ({ page, request }) => {
    const robots = await (await request.get('/robots.txt')).text();
    expect(robots).toContain('Disallow: /admin');

    await signIn(page);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });
});

test.describe('the dry run', () => {
  test('previews what would happen without writing anything', async ({ page }) => {
    const title = uniqueTitle();
    await signIn(page);
    await upload(page, [
      HEADERS,
      ['DRY-1', title, '19.99', 'Testbrand', 'draft'],
      ['DRY-2', 'Zz Fixture Two', '39.00', 'Testbrand', 'draft'],
    ]);

    await expect(previewTable(page)).toBeVisible();
    await expect(previewTable(page).getByRole('row')).toHaveCount(3); // header + 2
    await expect(previewTable(page).getByText(title)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import 2 products' })).toBeEnabled();

    // Nothing has been written: the receipt only appears after a commit.
    await expect(receipt(page)).toHaveCount(0);
  });

  test('groups variant rows into one product', async ({ page }) => {
    await signIn(page);
    await upload(page, [
      [...HEADERS, 'Option1 Name', 'Option1 Value'],
      ['VAR-1', 'Zz Fixture Variants', '19.99', 'Testbrand', 'draft', 'Length', '1m'],
      ['VAR-2', 'Zz Fixture Variants', '24.50', 'Testbrand', 'draft', 'Length', '2m'],
    ]);

    await expect(previewTable(page).getByRole('row')).toHaveCount(2); // header + 1
    // Two rows, one product, and the price shown as a range rather than a guess.
    await expect(previewTable(page)).toContainText('$19.99 – $24.50');
    await expect(page.getByRole('button', { name: 'Import 1 product' })).toBeVisible();
  });

  test('names the row and the fix for a cell it cannot read', async ({ page }) => {
    await signIn(page);
    await upload(page, [
      HEADERS,
      ['BAD-1', 'Zz Fixture Good', '19.99', 'Testbrand', 'draft'],
      ['BAD-2', 'Zz Fixture Bad', 'about twenty dollars', 'Testbrand', 'draft'],
    ]);

    const row = problemsTable(page).getByRole('row').filter({ hasText: 'Price' });
    await expect(row).toContainText('3'); // header is row 1, so the bad row is 3
    await expect(row).toContainText('is not a price');

    // The good row still imports. Three bad rows must never block 397 good ones.
    await expect(page.getByRole('button', { name: 'Import 1 product' })).toBeEnabled();
  });

  test('refuses a date it cannot read unambiguously', async ({ page }) => {
    await signIn(page);
    await upload(page, [
      [...HEADERS, 'Compare At Price', 'Offer Ends At'],
      ['AMB-1', 'Zz Fixture Ambiguous', '19.99', 'Testbrand', 'draft', '29.99', '03/04/2026'],
    ]);

    await expect(problemsTable(page)).toContainText('day-first or month-first');
  });
});

test.describe('the column mapping', () => {
  test('blocks the import when a required column is not mapped', async ({ page }) => {
    await signIn(page);
    // "Cost" is not a spelling of price the detector knows, on purpose.
    await upload(page, [
      ['Item Code', 'Product', 'Cost', 'Brand', 'Status'],
      ['MAP-1', 'Zz Fixture Mapped', '19.99', 'Testbrand', 'draft'],
    ]);

    await expect(alerts(page)).toContainText('Map a column to Price');
    await expect(page.getByRole('button', { name: /^Import/ })).toBeDisabled();
  });

  test('accepts the column the operator points at', async ({ page }) => {
    await signIn(page);
    await upload(page, [
      ['Item Code', 'Product', 'Cost', 'Brand', 'Status'],
      ['MAP-2', 'Zz Fixture Mapped', '19.99', 'Testbrand', 'draft'],
    ]);

    await page.getByLabel('Column for Price').selectOption({ label: 'Cost' });

    await expect(previewTable(page)).toContainText('$19.99');
    await expect(page.getByRole('button', { name: 'Import 1 product' })).toBeEnabled();
  });

  test('shows real values beside each column, so the right one can be picked', async ({ page }) => {
    await signIn(page);
    await upload(page, [
      ['Item Code', 'Product', 'Cost', 'Brand', 'Status'],
      ['MAP-3', 'Zz Fixture Sample', '19.99', 'Testbrand', 'draft'],
    ]);

    const mapping = page.getByRole('table', {
      name: 'Product fields and the spreadsheet column each reads',
    });
    await expect(mapping.getByRole('row').filter({ hasText: 'SKU' }).first()).toContainText(
      'MAP-3',
    );
  });
});

test.describe('committing', () => {
  // These write. Serial so two of them never race on the same catalogue.
  test.describe.configure({ mode: 'serial' });

  test('writes, reports what it wrote, and updates on a second run', async ({ page }) => {
    const title = uniqueTitle();
    const sheet = [HEADERS, [uniqueSku('CMT'), title, '19.99', 'Testbrand', 'draft']] as const;

    await signIn(page);
    await upload(page, sheet);
    await page.getByRole('button', { name: 'Import 1 product' }).click();

    await expect(receipt(page)).toContainText('Imported 1 product.');
    // No divergence warning: what was written is what was previewed.
    await expect(receipt(page)).not.toContainText('differs from the preview');
    await expect(previewTable(page)).toContainText('new');

    // The proof that it persisted: the same sheet is now an update, not a create.
    await page.reload();
    await upload(page, sheet);
    await expect(previewTable(page)).toContainText('update');
    await expect(previewTable(page)).not.toContainText('new');
  });

  test('a draft stays off the storefront', async ({ page }) => {
    const title = uniqueTitle();
    const slug = title.toLowerCase().replaceAll(' ', '-');

    await signIn(page);
    await upload(page, [HEADERS, [uniqueSku('CMT'), title, '29.99', 'Testbrand', 'draft']]);
    await page.getByRole('button', { name: 'Import 1 product' }).click();
    await expect(receipt(page)).toContainText('Imported 1 product.');

    // Imported, saved, and still a 404 to a customer — status is honoured on the
    // way in rather than being something the importer decides for itself.
    const response = await page.goto(`/en/products/${slug}`);
    expect(response?.status()).toBe(404);
  });
});

test.describe('a SKU that belongs to something else', () => {
  test.describe.configure({ mode: 'serial' });

  test('is refused with the product that owns it, not with a 500', async ({ page }) => {
    const sku = uniqueSku('CONF');
    const first = uniqueTitle();
    const renamed = `${first} Renamed`;

    await signIn(page);
    await upload(page, [HEADERS, [sku, first, '19.99', 'Testbrand', 'draft']]);
    await page.getByRole('button', { name: 'Import 1 product' }).click();
    await expect(receipt(page)).toContainText('Imported 1 product.');

    /*
     * The exact sequence that used to crash: the product is renamed, so the slug
     * changes and the sheet reads as a create — while the SKU is still owned by
     * the product under the old slug. The unique index would refuse it midway
     * through the write, with a 500 and a partly-written catalogue.
     */
    await page.reload();
    await upload(page, [HEADERS, [sku, renamed, '19.99', 'Testbrand', 'draft']]);

    await expect(problemsTable(page)).toContainText('already belongs to');
    await expect(problemsTable(page)).toContainText(sku);
    await expect(page.getByRole('button', { name: /^Import 0 products/ })).toBeDisabled();
  });
});

test.describe('refusing bad uploads', () => {
  test('rejects a file that is not an .xlsx', async ({ page }) => {
    await signIn(page);
    await page.getByLabel('Catalogue spreadsheet (.xlsx)').setInputFiles({
      name: 'catalogue.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('SKU,Title,Price\nA-1,Thing,1.00'),
    });

    await expect(alerts(page)).toContainText('Only .xlsx files');
  });

  test('rejects a file that claims to be an .xlsx and is not', async ({ page }) => {
    await signIn(page);
    await page.getByLabel('Catalogue spreadsheet (.xlsx)').setInputFiles({
      name: 'catalogue.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from('this is not a zip archive'),
    });

    // An expected outcome of accepting uploads, so a sentence — not a 500.
    await expect(alerts(page)).toContainText('could not be read');
  });
});

test.describe('accessibility', () => {
  const scan = (page: Page) =>
    new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();

  test('the login page has no WCAG 2.1 AA violations', async ({ page }) => {
    await page.goto('/admin/login');
    const results = await scan(page);
    if (results.violations.length > 0) console.log(JSON.stringify(results.violations, null, 2));
    expect(results.violations).toEqual([]);
  });

  test('the import screen has no WCAG 2.1 AA violations, tables and all', async ({ page }) => {
    await signIn(page);
    await upload(page, [
      HEADERS,
      ['A11Y-1', 'Zz Fixture Accessible', '19.99', 'Testbrand', 'draft'],
      ['A11Y-2', 'Zz Fixture Broken', 'not a price', 'Testbrand', 'draft'],
    ]);
    // Scanned with every panel on screen: the mapping selects, the problems
    // table and the preview table are where the violations would be.
    await expect(problemsTable(page)).toBeVisible();

    const results = await scan(page);
    if (results.violations.length > 0) console.log(JSON.stringify(results.violations, null, 2));
    expect(results.violations).toEqual([]);
  });
});
