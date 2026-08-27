import { totalItems } from '@modules/cart';
import type { Locale } from '@platform/locale';
import { getTranslations } from 'next-intl/server';
import { readCart } from './cart/cookie';

/**
 * The storefront's one piece of chrome.
 *
 * It exists because the cart has to be reachable from every page — a cart you
 * can only get to by typing a URL is a cart nobody uses. Everything here is a
 * plain link, so it works before hydration and with JavaScript unavailable.
 *
 * The count is read from the cookie, which costs no database round trip: the
 * cart holds SKUs and quantities, and how many items are in it needs neither
 * prices nor products.
 */
export const SiteHeader = async ({ locale }: { locale: Locale }) => {
  const t = await getTranslations({ locale, namespace: 'nav' });
  const tCart = await getTranslations({ locale, namespace: 'cart' });

  const count = totalItems(await readCart());

  const link =
    'text-sm text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

  return (
    <>
      {/*
        First focusable thing on the page. A keyboard user should not have to tab
        through the whole nav on every page to reach the content.
      */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-3 focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-void"
      >
        {t('skipToContent')}
      </a>

      <header className="border-hairline border-b bg-surface/60 backdrop-blur">
        <nav
          aria-label={t('primary')}
          className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4"
        >
          <a
            href={`/${locale}`}
            className="text-sm font-semibold tracking-tight text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Taz4Tech
          </a>

          <a href={`/${locale}/products`} className={link}>
            {t('products')}
          </a>
          <a href={`/${locale}/collections`} className={link}>
            {t('collections')}
          </a>

          <a
            href={`/${locale}/cart`}
            // The count is IN the accessible name rather than beside it: a screen
            // reader announcing "Cart" and then "3" separately leaves the reader
            // to guess what the three belongs to.
            aria-label={tCart('itemCount', { count })}
            className="ms-auto flex items-center gap-2 rounded-lg border border-hairline px-3 py-1.5 text-sm text-ink transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span aria-hidden="true">{tCart('title')}</span>
            {count > 0 && (
              <span
                aria-hidden="true"
                className="min-w-5 rounded-full bg-accent px-1.5 text-center text-xs font-medium tabular-nums text-void"
              >
                {count}
              </span>
            )}
          </a>
        </nav>
      </header>
    </>
  );
};
