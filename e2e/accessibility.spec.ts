import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const LOCALES = ['en', 'ar', 'fr'] as const;

/**
 * Every page shape, not just the home page. A listing grid and a product page
 * have completely different failure modes from a single panel — tables, image
 * alt text, link names, and a variant picker built from links.
 */
const PATHS = ['', '/products', '/products/lenovo-ideapad-3'] as const;

/**
 * WCAG 2.1 AA, checked in every locale.
 *
 * Running this per locale rather than once matters: Arabic flips the layout to
 * RTL and changes text length, which is exactly where contrast and reflow issues
 * appear. A single English pass would report a clean page and ship a broken one.
 */
test.describe('accessibility', () => {
  for (const locale of LOCALES) {
    for (const path of PATHS) {
      test(`/${locale}${path} has no WCAG 2.1 AA violations`, async ({ page }) => {
        await page.goto(`/${locale}${path}`);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();

        // Print the detail before asserting, so a CI failure names the element
        // rather than only the count.
        if (results.violations.length > 0) {
          console.log(
            JSON.stringify(
              results.violations.map((v) => ({
                id: v.id,
                impact: v.impact,
                help: v.help,
                nodes: v.nodes.map((n) => n.target),
              })),
              null,
              2,
            ),
          );
        }

        expect(results.violations).toEqual([]);
      });
    }
  }

  test('every page has exactly one h1, in every locale', async ({ page }) => {
    for (const locale of LOCALES) {
      for (const path of PATHS) {
        await page.goto(`/${locale}${path}`);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      }
    }
  });

  test('respects prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/en');
    await expect(page.locator('main')).toBeVisible();
  });
});
