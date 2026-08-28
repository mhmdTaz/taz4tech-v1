import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { ADMIN_PASSWORD } from '../playwright.config';

/**
 * The footer, the written pages, and the language switcher.
 *
 * One test here edits the store's settings to check the registry number appears
 * — the same document every other spec reads — so it puts it back in a `finally`
 * and this file is serial.
 */

const WRITTEN = ['delivery', 'returns', 'terms', 'privacy', 'contact'] as const;

const footer = (page: Page) => page.getByRole('contentinfo');

const signIn = async (page: Page) => {
  await page.goto('/admin/login');
  if (!page.url().includes('/admin/login')) return;

  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible();
};

test.describe.configure({ mode: 'serial' });

test.describe('the footer', () => {
  test('is on every page, not just the home page', async ({ page }) => {
    for (const path of ['', '/products', '/collections', '/cart', '/delivery']) {
      await page.goto(`/en${path}`);
      await expect(footer(page)).toBeVisible();
    }
  });

  test('names the shop and gives a number to ring', async ({ page }) => {
    // Law 81/2018 Art. 31 wants the seller identified on the storefront. Until
    // this footer existed, the only place that happened was a debug panel.
    await page.goto('/en');

    await expect(footer(page)).toContainText('Taz4Tech');
    await expect(footer(page).locator('a[href^="tel:"]')).toHaveAttribute(
      'href',
      'tel:+96170000000',
    );
  });

  test('reaches every written page', async ({ page }) => {
    await page.goto('/en');

    for (const path of WRITTEN) {
      const link = footer(page).locator(`a[href="/en/${path}"]`);
      await expect(link).toHaveCount(1);
    }
  });

  test('shows the registry number once there is one, and nothing when there is not', async ({
    page,
  }) => {
    await page.goto('/en');
    await expect(footer(page)).not.toContainText('Commercial registry');

    await signIn(page);
    try {
      await page.goto('/admin/settings');
      await page.getByLabel('Commercial registry number').fill('CR-77123');
      await page.getByRole('button', { name: 'Save settings' }).click();
      await page.waitForURL(/[?&](saved|error)=/);

      await page.goto('/en');
      await expect(footer(page)).toContainText('CR-77123');
    } finally {
      await page.goto('/admin/settings');
      await page.getByLabel('Commercial registry number').fill('');
      await page.getByRole('button', { name: 'Save settings' }).click();
      await page.waitForURL(/[?&](saved|error)=/);
    }
  });
});

test.describe('the language switcher', () => {
  test('keeps you on the page you were reading', async ({ page }) => {
    /*
     * The reason it is a client component at all. Three links to the locale home
     * pages would be simpler and would throw a reader back to the front of the
     * shop for the crime of wanting to read in Arabic.
     */
    await page.goto('/en/returns');
    await footer(page).getByRole('link', { name: 'العربية' }).click();

    await expect(page).toHaveURL(/\/ar\/returns$/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  test('does not link to the language you are already reading', async ({ page }) => {
    await page.goto('/fr/terms');

    const nav = footer(page).getByRole('navigation', { name: 'Langue' });
    await expect(nav.getByRole('link', { name: 'Français' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'English' })).toHaveCount(1);
  });

  test('works with JavaScript disabled', async ({ browser }) => {
    // The hrefs resolve during the server render, so this is a plain link like
    // everything else on the storefront.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    await page.goto('/en/privacy');
    await footer(page).getByRole('link', { name: 'Français' }).click();
    await expect(page).toHaveURL(/\/fr\/privacy$/);

    await context.close();
  });
});

test.describe('the written pages', () => {
  test('each render with one h1 in every locale', async ({ page }) => {
    for (const locale of ['en', 'ar', 'fr']) {
      for (const path of WRITTEN) {
        await page.goto(`/${locale}/${path}`);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      }
    }
  });

  test('are translated, not the English text three times', async ({ page }) => {
    await page.goto('/ar/delivery');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('التوصيل');

    await page.goto('/fr/returns');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Retours');
  });

  test('declare a canonical and are open to indexing', async ({ page }) => {
    // Unlike checkout, these are pages the shop WANTS found: "does this shop
    // deliver to Akkar" is a search somebody makes.
    await page.goto('/en/delivery');

    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/en\/delivery$/);
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
  });

  test('are listed in the sitemap, in all three locales', async ({ request }) => {
    const xml = await (await request.get('/sitemap.xml')).text();

    for (const path of WRITTEN) {
      expect(xml).toContain(`/en/${path}`);
      expect(xml).toContain(`/ar/${path}`);
    }
  });
});

test.describe('the delivery page', () => {
  /*
   * Pricing a governorate and reading it back is asserted in
   * admin-settings.spec.ts, which is the one file that edits store settings.
   * Two specs mutating that document ran in parallel and raced — one restored
   * the fees while the other was still asserting on them.
   */

  test('names all eight governorates', async ({ page }) => {
    await page.goto('/en/delivery');

    for (const name of ['Beirut', 'Mount Lebanon', 'North', 'Akkar', 'Nabatieh']) {
      await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(1);
    }
  });
});

test.describe('the contact page', () => {
  test('offers the number to call and the same number on WhatsApp', async ({ page }) => {
    await page.goto('/en/contact');

    await expect(page.locator('main a[href^="tel:"]')).toHaveAttribute('href', 'tel:+96170000000');
    await expect(page.getByRole('link', { name: /WhatsApp/ })).toHaveAttribute(
      'href',
      'https://wa.me/96170000000',
    );
  });
});

test.describe('accessibility', () => {
  for (const locale of ['en', 'ar']) {
    test(`the written pages have no WCAG 2.1 AA violations in ${locale}`, async ({ page }) => {
      for (const path of WRITTEN) {
        await page.goto(`/${locale}/${path}`);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();

        if (results.violations.length > 0) {
          console.log(path, JSON.stringify(results.violations, null, 2));
        }
        expect(results.violations, path).toEqual([]);
      }
    });
  }
});
