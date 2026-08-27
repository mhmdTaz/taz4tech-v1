import { expect, type Page, test } from '@playwright/test';
import { ADMIN_PASSWORD } from '../playwright.config';
import { xlsxUpload } from './support/workbook';

/**
 * Taking copies of supplier images, end to end.
 *
 * The "supplier" is this application. The importer is handed an ABSOLUTE URL
 * pointing at a file the app already serves, so the whole path runs for real —
 * an outbound HTTP fetch, a content-type check, a hash, a write, and a product
 * whose image is served back from our own origin — with no external network and
 * nothing to be flaky about.
 */

const HEADERS = ['SKU', 'Title', 'Price', 'Brand', 'Status', 'Image URL'] as const;
const BRAND = 'Mediabrand';

const unique = () => `Zzmedia${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;

/** A real PNG this server already serves, addressed the way a supplier sheet would. */
const supplierImage = (baseURL: string) => `${baseURL}/media/laptop.png`;

const signIn = async (page: Page) => {
  await page.goto('/admin/login');
  if (!page.url().includes('/admin/login')) return;

  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible();
};

const importRow = async (page: Page, row: readonly string[]) => {
  await page.goto('/admin/import');
  await page
    .getByLabel('Catalogue spreadsheet (.xlsx)')
    .setInputFiles(await xlsxUpload('media.xlsx', [HEADERS, row]));

  await page.getByRole('button', { name: /^Import 1 product/ }).click();
  await expect(page.locator('main').getByRole('status')).toContainText('Imported');
};

const receipt = (page: Page) => page.locator('main').getByRole('status');

test.describe.configure({ mode: 'serial' });

test.describe('taking a copy at import time', () => {
  test('stores the picture and points the product at our own origin', async ({ page, baseURL }) => {
    const title = unique();
    await signIn(page);
    await importRow(page, [
      `MD-${crypto.randomUUID().slice(0, 8)}`,
      title,
      '19.99',
      BRAND,
      'draft',
      supplierImage(baseURL ?? ''),
    ]);

    await expect(receipt(page)).toContainText('took 1 image');

    // The stored URL is content-addressed: /media/<sha256>. Nothing about it
    // mentions the supplier, so the supplier cannot take it away.
    await page.goto(`/admin/products?q=${encodeURIComponent(title)}`);
    await expect(page.getByRole('row').filter({ hasText: title })).toBeVisible();
  });

  test('serves those bytes back, cacheable forever', async ({ page, request, baseURL }) => {
    const title = unique();
    await signIn(page);
    await importRow(page, [
      `MD-${crypto.randomUUID().slice(0, 8)}`,
      title,
      '19.99',
      BRAND,
      'draft',
      supplierImage(baseURL ?? ''),
    ]);

    /*
     * The id is the SHA-256 of the PNG in public/, so the same file imported
     * from anywhere lands on the same URL — which is exactly what makes it safe
     * to cache for a year.
     */
    const bytes = await (await request.get('/media/laptop.png')).body();
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
    const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

    const stored = await request.get(`/media/${id}`);
    expect(stored.status()).toBe(200);
    expect(stored.headers()['content-type']).toBe('image/png');
    expect(stored.headers()['cache-control']).toContain('immutable');
    expect(stored.headers()['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(await stored.body(), bytes)).toBe(0);
  });

  test('fetches one photograph once, however many rows name it', async ({ page, baseURL }) => {
    // A four-hundred-row sheet for twenty products shares its images heavily.
    const url = supplierImage(baseURL ?? '');
    await signIn(page);

    await page.goto('/admin/import');
    await page
      .getByLabel('Catalogue spreadsheet (.xlsx)')
      .setInputFiles(
        await xlsxUpload('media.xlsx', [
          HEADERS,
          [`MD-${crypto.randomUUID().slice(0, 8)}`, unique(), '19.99', BRAND, 'draft', url],
          [`MD-${crypto.randomUUID().slice(0, 8)}`, unique(), '29.99', BRAND, 'draft', url],
        ]),
      );
    await page.getByRole('button', { name: /^Import 2 product/ }).click();

    // Two products, one image — and on a re-import, zero, because the bytes are
    // already here and the id is derived from them.
    await expect(receipt(page)).toContainText('Imported 2 products');
    await expect(receipt(page)).not.toContainText('took 2 images');
  });
});

test.describe('when the supplier image cannot be had', () => {
  test('imports the product anyway, and says which picture it lost', async ({ page, baseURL }) => {
    /*
     * A supplier CDN having a bad afternoon must not stop four hundred products
     * from arriving. The product lands without that image and the receipt names
     * the slug and the reason, so the sheet can be fixed and re-imported.
     */
    const title = unique();
    await signIn(page);
    await importRow(page, [
      `MD-${crypto.randomUUID().slice(0, 8)}`,
      title,
      '19.99',
      BRAND,
      'draft',
      `${baseURL ?? ''}/media/there-is-no-such-file.png`,
    ]);

    await expect(receipt(page)).toContainText('Imported 1 product');
    await expect(receipt(page)).toContainText('no image for');
    await expect(receipt(page)).toContainText('404');
  });

  test('refuses something that is not an image, without failing the row', async ({
    page,
    baseURL,
  }) => {
    // Every CDN eventually answers 200 with an HTML error page. Without the
    // content-type check that would be stored as a product photograph.
    const title = unique();
    await signIn(page);
    await importRow(page, [
      `MD-${crypto.randomUUID().slice(0, 8)}`,
      title,
      '19.99',
      BRAND,
      'draft',
      `${baseURL ?? ''}/en/products`,
    ]);

    await expect(receipt(page)).toContainText('Imported 1 product');
    await expect(receipt(page)).toContainText('is not an image we can show');
  });
});

test.describe('serving a stored image', () => {
  test('404s on an id that is not a hash, without touching the database', async ({ request }) => {
    for (const id of ['nope', '../../etc/passwd', 'A'.repeat(64), `${'a'.repeat(64)}0`]) {
      const response = await request.get(`/media/${encodeURIComponent(id)}`);
      expect(response.status(), id).toBe(404);
    }
  });

  test('404s on a well-formed id nobody stored', async ({ request }) => {
    const response = await request.get(`/media/${'f'.repeat(64)}`);
    expect(response.status()).toBe(404);
  });
});

test.describe('the storefront', () => {
  test('renders catalogue images through the optimiser', async ({ page }) => {
    /*
     * The reason all of this exists. `next/image` will not touch a host it does
     * not trust, so while catalogue pictures lived on supplier domains every one
     * of them was a plain <img> with a lint suppression over it.
     */
    await page.goto('/en/products/lenovo-ideapad-3');

    const hero = page.locator('main img').first();
    await expect(hero).toHaveAttribute('src', /\/_next\/image\?url=/);
    await expect(hero).toHaveAttribute('srcset', /w=640/);
  });

  test('loads the hero eagerly and the listing tiles lazily', async ({ page }) => {
    /*
     * Asserted as eager-versus-lazy rather than on a `fetchpriority` attribute.
     * `priority` is Next's API; how it spells the hint in the DOM is Next's
     * business and has changed between versions. What must stay true is that the
     * largest contentful paint is not queued behind lazy loading, and that a
     * grid of tiles below the fold is.
     */
    await page.goto('/en/products/lenovo-ideapad-3');
    await expect(page.locator('main img').first()).not.toHaveAttribute('loading', 'lazy');

    await page.goto('/en/products');
    await expect(page.locator('main img').first()).toHaveAttribute('loading', 'lazy');
  });

  test('still has alt text on every catalogue image', async ({ page }) => {
    // The domain requires it and axe would catch a missing one, but the swap to
    // next/image rewrote every one of these tags — worth asserting directly.
    await page.goto('/en/products');

    for (const image of await page.locator('main img').all()) {
      await expect(image).not.toHaveAttribute('alt', '');
    }
  });
});
