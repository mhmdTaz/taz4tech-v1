import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Quick view: a peek at a product without leaving the grid.
 *
 * Read-only against the seeded demo catalogue, so these run in parallel with
 * everything else and leave nothing behind.
 */

const dialog = (page: Page) => page.getByRole('dialog');

const triggerFor = (page: Page, name: RegExp) =>
  page.locator('main ul li').filter({ hasText: name }).getByRole('link', { name: 'Quick view' });

/**
 * Open the quick view for one product, on a listing narrowed to it.
 *
 * Searched rather than browsed. The listing is paginated and other specs
 * publish products in order to buy them, so a demo product that is on page one
 * today is on page two while one of those is live — which is exactly how this
 * failed: the Anker tile was simply not on the page being looked at.
 */
const openFor = async (page: Page, name: RegExp) => {
  const term = name.source.replace(/[^\w\s-]/g, '').trim();
  await page.goto(`/en/products?q=${encodeURIComponent(term)}`);
  await triggerFor(page, name).click();
  await expect(dialog(page)).toBeVisible();
};

test.describe('the trigger', () => {
  test('is a link to the product page, not a button', async ({ page }) => {
    /*
     * The whole progressive-enhancement story rests on this. Before hydration —
     * a real slice of the first interactions on a Lebanese mobile connection —
     * and with JavaScript unavailable, it has to still go somewhere useful.
     */
    await page.goto('/en/products');
    await expect(triggerFor(page, /Lenovo IdeaPad 3/)).toHaveAttribute(
      'href',
      '/en/products/lenovo-ideapad-3',
    );
  });

  test('announces that it opens a dialog', async ({ page }) => {
    await page.goto('/en/products');
    await expect(triggerFor(page, /Lenovo IdeaPad 3/)).toHaveAttribute('aria-haspopup', 'dialog');
  });

  test('does not swallow the tile link', async ({ page }) => {
    // The tile is one big anchor and the trigger sits on top of it. Clicking the
    // tile itself must still navigate.
    await page.goto('/en/products');
    await page
      .locator('main ul li a[href*="/products/"]')
      .filter({ hasText: /Anker/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/en\/products\/anker-usb-c-cable-2m$/);
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the product page it links to works', async ({ page }) => {
    // The destination of every quick-view trigger. Variant selection there is a
    // URL rather than client state precisely so this holds.
    await page.goto('/en/products/lenovo-ideapad-3');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Lenovo IdeaPad 3');
    await expect(page.getByRole('link', { name: '512GB' })).toBeVisible();
  });

  test('no dialog is showing', async ({ page }) => {
    await page.goto('/en/products');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('the listing HTML carries the tiles and the quick-view links', async ({ request }) => {
    /*
     * Asserted against the RAW HTML rather than through a browser, on purpose.
     *
     * The grid sits behind a Suspense boundary and is streamed, and React swaps
     * streamed content in with an inline script — so a browser with JavaScript
     * disabled sits on the loading skeleton indefinitely. That is a pre-existing
     * property of the listing, not something quick view introduced, and it is
     * flagged rather than reversed here: removing the boundary would block the
     * page shell on a database query.
     *
     * What this does prove is that the markup is all there: a crawler that reads
     * HTML without executing it sees every tile, every product link and every
     * quick-view trigger.
     */
    const html = await (await request.get('/en/products')).text();

    expect(html).toContain('/en/products/lenovo-ideapad-3');
    expect(html).toContain('Quick view');
    expect(html).toContain('Lenovo IdeaPad 3');
  });
});

test.describe('opening and closing', () => {
  test('opens over the listing without changing the URL', async ({ page }) => {
    // A transient peek. The tile link is the thing that is shareable and
    // indexable; the dialog deliberately does not claim an address.
    await openFor(page, /Lenovo IdeaPad 3/);

    // Still on the listing it was opened from — the search term openFor used is
    // part of that URL, and what matters is that the dialog added nothing.
    await expect(page).toHaveURL(/\/en\/products\?q=/);
    await expect(page).not.toHaveURL(/quick|dialog|modal/);
  });

  test('shows the product, its price and the selected SKU', async ({ page }) => {
    await openFor(page, /Lenovo IdeaPad 3/);

    await expect(dialog(page)).toContainText('Lenovo IdeaPad 3');
    await expect(dialog(page)).toContainText('$1,199.00');
    await expect(dialog(page)).toContainText('IP3-BLK-256');
  });

  test('quotes the CHEAPEST variant first', async ({ page }) => {
    // Opening on the dearest variant would quote a price the customer did not
    // see on the tile they just clicked.
    await openFor(page, /Lenovo IdeaPad 3/);
    await expect(dialog(page)).toContainText('IP3-BLK-256');
  });

  test('closes on Escape', async ({ page }) => {
    await openFor(page, /Lenovo IdeaPad 3/);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  });

  test('closes on the close button', async ({ page }) => {
    await openFor(page, /Lenovo IdeaPad 3/);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(dialog(page)).toBeHidden();
  });

  test('closes on a backdrop click', async ({ page }) => {
    await openFor(page, /Lenovo IdeaPad 3/);
    // The far corner of the viewport is backdrop, never dialog content.
    await page.mouse.click(5, 5);
    await expect(dialog(page)).toBeHidden();
  });

  test('returns focus to the trigger that opened it', async ({ page }) => {
    // Native <dialog> gives this for free, which is most of why it is used here
    // rather than a div with a hand-written focus trap.
    await openFor(page, /Lenovo IdeaPad 3/);
    await page.keyboard.press('Escape');

    await expect(triggerFor(page, /Lenovo IdeaPad 3/)).toBeFocused();
  });

  test('traps focus while it is open', async ({ page }) => {
    await openFor(page, /Lenovo IdeaPad 3/);

    // Tab far enough to have left any non-modal container, then check we are
    // still inside the dialog.
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    await expect(dialog(page).locator(':focus')).toHaveCount(1);
  });

  test('leads to the full product page', async ({ page }) => {
    await openFor(page, /Lenovo IdeaPad 3/);
    await dialog(page).getByRole('link', { name: 'View full details' }).click();

    await expect(page).toHaveURL(/\/en\/products\/lenovo-ideapad-3$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Lenovo IdeaPad 3');
  });
});

test.describe('choosing a variant', () => {
  test('changes the SKU and the price', async ({ page }) => {
    await openFor(page, /Lenovo IdeaPad 3/);
    await dialog(page).getByRole('button', { name: '512GB' }).click();

    await expect(dialog(page)).toContainText('IP3-BLK-512');
    await expect(dialog(page)).toContainText('$1,399.00');
  });

  test('marks a combination that does not exist as unavailable', async ({ page }) => {
    /*
     * Silver comes in 256GB only. Shown DISABLED rather than hidden, so the
     * customer can see that the combination does not exist instead of wondering
     * why an option vanished when they picked a colour — the same rule the
     * product page follows.
     */
    await openFor(page, /Lenovo IdeaPad 3/);
    await dialog(page).getByRole('button', { name: 'Silver' }).click();

    await expect(dialog(page).getByRole('button', { name: '512GB' })).toBeDisabled();
    await expect(dialog(page).getByRole('button', { name: '256GB' })).toBeEnabled();
  });

  test('says which value is selected, not only by colour', async ({ page }) => {
    await openFor(page, /Lenovo IdeaPad 3/);
    await expect(dialog(page).getByRole('button', { name: 'Black' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(dialog(page).getByRole('button', { name: 'Silver' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('starts from the current selection when changing another option', async ({ page }) => {
    // Picking 512GB from Black/256 must land on Black/512, not on some other
    // colour that happens to have 512.
    await openFor(page, /Lenovo IdeaPad 3/);

    /*
     * The starting point is asserted, not assumed.
     *
     * Without this, a dialog that opened on Silver for any reason fails on the
     * line below and reads as "changing an option loses the colour" — a bug in
     * the component — when the component did exactly the right thing from a
     * different starting state. Two lines to make the failure name itself.
     */
    await expect(dialog(page).getByRole('button', { name: 'Black' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await dialog(page).getByRole('button', { name: '512GB' }).click();
    await expect(dialog(page).getByRole('button', { name: 'Black' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

test.describe('an offer', () => {
  test('shows the was-price and the expiry date', async ({ page }) => {
    // Consumer protection law requires the expiry to be SHOWN wherever the offer
    // is, not merely stored — including in a dialog.
    await openFor(page, /Samsung Galaxy A55/);

    await expect(dialog(page)).toContainText('$449.00');
    await expect(dialog(page)).toContainText('$389.00');
    await expect(dialog(page)).toContainText('Offer ends');
  });

  test('drops the offer on a variant that is not discounted', async ({ page }) => {
    await openFor(page, /Samsung Galaxy A55/);
    await dialog(page).getByRole('button', { name: '256GB' }).click();

    await expect(dialog(page)).not.toContainText('Offer ends');
  });
});

test.describe('a product with no options', () => {
  test('opens without an empty picker', async ({ page }) => {
    await openFor(page, /Anker/);
    await expect(dialog(page)).toContainText('ANK-C2C-2M');
    await expect(dialog(page).getByRole('group')).toHaveCount(0);
  });
});

test.describe('other locales', () => {
  test('opens in Arabic with translated text and RTL layout', async ({ page }) => {
    await page.goto('/ar/products');
    // Not filtered by product name: the Arabic title is a translation, so
    // matching on the English one would pass or fail for the wrong reason.
    await page.locator('main ul li').getByRole('link', { name: 'عرض سريع' }).first().click();

    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // Translated chrome, and Latin digits in Arabic — deliberately, see the
    // note in platform/money. Asserted on the price FORMAT rather than on one
    // product's price, because which tile comes first is not this test's point.
    await expect(dialog(page).getByRole('button', { name: 'إغلاق' })).toBeVisible();
    await expect(dialog(page)).toContainText(/[0-9]{1,3}(,[0-9]{3})*\.[0-9]{2}/);
  });

  test('links to the product page in the same locale', async ({ page }) => {
    await page.goto('/fr/products');
    await page.locator('main ul li').getByRole('link', { name: 'Aperçu rapide' }).first().click();

    await expect(
      dialog(page).getByRole('link', { name: 'Voir la fiche complète' }),
    ).toHaveAttribute('href', /^\/fr\/products\//);
  });
});

test.describe('inside a collection', () => {
  test('works on a collection listing too', async ({ page }) => {
    // The collection page renders the same grid, so the dialog comes with it —
    // which is the payoff for modelling a collection as a saved query.
    await page.goto('/en/collections/laptops');
    await page.locator('main ul li').getByRole('link', { name: 'Quick view' }).first().click();
    await expect(dialog(page)).toBeVisible();
  });
});

test.describe('accessibility', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`the open dialog has no WCAG 2.1 AA violations in ${locale}`, async ({ page }) => {
      await page.goto(`/${locale}/products`);
      await page
        .locator('main ul li')
        .getByRole('link', { name: /Quick view|عرض سريع/ })
        .first()
        .click();
      await expect(dialog(page)).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      if (results.violations.length > 0) console.log(JSON.stringify(results.violations, null, 2));
      expect(results.violations).toEqual([]);
    });
  }
});
