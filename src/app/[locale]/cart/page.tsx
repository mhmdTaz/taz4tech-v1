import { MAX_QUANTITY, type PricedCart } from '@modules/cart';
import { isLocale, type Locale } from '@platform/locale';
import { format as formatMoney } from '@platform/money';
import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getContainer } from '@/composition';
import { clearUnavailable, removeLine, updateLine } from './actions';
import { readCart } from './cookie';

/** Reads a cookie and the database on every request. */
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};

  const t = await getTranslations({ locale, namespace: 'cart' });
  return {
    title: t('metaTitle'),
    // A cart is personal and has nothing to rank for. Keeping it out of the
    // index also keeps it out of anyone's crawl budget.
    robots: { index: false, follow: true },
  };
}

export default async function CartPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  await connection();

  const container = await getContainer();
  const priced = await container.cart.priceCart(await readCart(), locale);

  const t = await getTranslations({ locale, namespace: 'cart' });
  const money = (cents: number) => formatMoney({ cents, currency: priced.currency }, locale);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight text-ink">{t('title')}</h1>

      {priced.removed.length > 0 && (
        <div
          role="status"
          className="rounded-[var(--radius-panel)] border border-caution/60 bg-surface p-5"
        >
          <p className="font-medium text-caution">{t('removedTitle')}</p>
          <p className="text-sm text-muted">{t('removedBody', { count: priced.removed.length })}</p>
          {/*
            Cleared by a button, not by rendering the page. A Server Component
            cannot set a cookie — and more to the point, a cart that quietly
            shrinks while you look at it is worse than one that asks.
          */}
          <form action={clearUnavailable} className="mt-3">
            <input type="hidden" name="locale" value={locale} />
            <button
              type="submit"
              className="rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('removedClear')}
            </button>
          </form>
        </div>
      )}

      {priced.lines.length === 0 ? (
        <div className="flex flex-col items-start gap-4 rounded-[var(--radius-panel)] border border-hairline bg-surface p-8">
          <p className="text-base text-muted">{t('empty')}</p>
          <a
            href={`/${locale}/products`}
            className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-void transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t('continueShopping')}
          </a>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-4">
            {priced.lines.map((line) => (
              <li
                key={line.sku}
                className="flex flex-col gap-4 rounded-[var(--radius-panel)] border border-hairline bg-surface p-4 sm:flex-row sm:items-start"
              >
                <div className="relative aspect-4/3 w-full shrink-0 overflow-hidden rounded-lg border border-hairline bg-raised sm:w-32">
                  {line.imageUrl === null ? (
                    <div
                      aria-hidden="true"
                      className="h-full w-full bg-linear-to-br from-raised to-surface"
                    />
                  ) : (
                    // A fixed-size thumbnail, so `sizes` can name the one size
                    // it is ever rendered at rather than guess from the viewport.
                    <Image
                      src={line.imageUrl}
                      alt={line.imageAlt}
                      fill
                      sizes="96px"
                      className="object-cover"
                    />
                  )}
                </div>

                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <a
                    href={line.href}
                    className="font-medium text-ink underline-offset-4 hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {line.title}
                  </a>

                  {line.options.length > 0 && (
                    <p className="text-sm text-muted">
                      {line.options.map((option) => option.value).join(' · ')}
                    </p>
                  )}

                  <p className="flex flex-wrap items-baseline gap-2 text-sm">
                    {line.compareAtCents !== null && (
                      <span className="text-faint line-through">{money(line.compareAtCents)}</span>
                    )}
                    <span className="text-muted">{money(line.unitPriceCents)}</span>
                  </p>

                  {line.problem !== null && (
                    <p role="status" className="text-sm font-medium text-negative">
                      {line.problem.available === 0
                        ? t('noneLeft')
                        : t('onlyLeft', { count: line.problem.available })}
                    </p>
                  )}

                  {/*
                    Two plain forms, not one form with two buttons: without
                    JavaScript a second submit button posts the same fields, and
                    "remove" carrying a quantity is a request nobody made.
                  */}
                  <div className="flex flex-wrap items-end gap-3">
                    <form action={updateLine} className="flex items-end gap-2">
                      <input type="hidden" name="sku" value={line.sku} />
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="returnTo" value={`/${locale}/cart`} />
                      <label
                        htmlFor={`qty-${line.sku}`}
                        className="flex flex-col gap-1 text-xs text-faint"
                      >
                        {t('quantity')}
                        <input
                          id={`qty-${line.sku}`}
                          name="quantity"
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={MAX_QUANTITY}
                          defaultValue={line.quantity}
                          className="w-20 rounded-lg border border-hairline bg-raised px-2 py-1.5 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        />
                      </label>
                      <button
                        type="submit"
                        className="rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {t('update')}
                      </button>
                    </form>

                    <form action={removeLine}>
                      <input type="hidden" name="sku" value={line.sku} />
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="returnTo" value={`/${locale}/cart`} />
                      <button
                        type="submit"
                        className="rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted hover:text-negative focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {t('remove')}
                      </button>
                    </form>
                  </div>
                </div>

                <p className="shrink-0 text-base font-semibold tabular-nums text-ink">
                  {money(line.lineTotalCents)}
                </p>
              </li>
            ))}
          </ul>

          <Summary priced={priced} locale={locale} />
        </>
      )}
    </main>
  );
}

const Summary = async ({ priced, locale }: { priced: PricedCart; locale: Locale }) => {
  const t = await getTranslations({ locale, namespace: 'cart' });
  const money = (cents: number) => formatMoney({ cents, currency: priced.currency }, locale);

  return (
    <section
      aria-label={t('subtotal')}
      className="flex flex-col gap-4 rounded-[var(--radius-panel)] border border-hairline bg-surface p-6"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-base text-muted">{t('subtotal')}</span>
        <span className="text-2xl font-semibold tabular-nums text-ink">
          {money(priced.subtotalCents)}
        </span>
      </div>

      {/*
        Stated rather than calculated. Prices are what the customer pays; whether
        a VAT line can be broken out depends on registration, which is not
        settled — and the total would not change either way.
      */}
      <p className="text-sm text-faint">{t('vatNote')}</p>

      {/*
        A link, not a button: checkout is a page, and getting there should work
        with a middle click, a long press and no JavaScript at all.
      */}
      <a
        href={`/${locale}/checkout`}
        className="rounded-lg bg-accent px-4 py-3 text-center text-sm font-medium text-void transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {t('checkout')}
      </a>
    </section>
  );
};
