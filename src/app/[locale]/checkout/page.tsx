import { deliveryFeeFor, deliverySpread } from '@modules/store';
import { isLocale } from '@platform/locale';
import { format as formatMoney } from '@platform/money';
import { REGIONS } from '@platform/regions';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getContainer } from '@/composition';
import { readCart } from '../cart/cookie';
import { placeOrder } from './actions';

export const dynamic = 'force-dynamic';

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};

  const t = await getTranslations({ locale, namespace: 'checkout' });
  // Personal, and with nothing to rank for.
  return { title: t('metaTitle'), robots: { index: false, follow: true } };
}

const one = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? '';

const field =
  'w-full rounded-lg border border-hairline bg-raised px-3 py-2.5 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

export default async function CheckoutPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  await connection();

  const query = await searchParams;
  const container = await getContainer();
  const priced = await container.cart.priceCart(await readCart(), locale);

  const t = await getTranslations({ locale, namespace: 'checkout' });
  const tRegion = await getTranslations({ locale, namespace: 'region' });
  const money = (cents: number) => formatMoney({ cents, currency: priced.currency }, locale);

  if (priced.lines.length === 0) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col items-start gap-6 px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">{t('title')}</h1>
        <p className="text-base text-muted">{t('emptyCart')}</p>
        <a
          href={`/${locale}/products`}
          className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-void hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t('continueShopping')}
        </a>
      </main>
    );
  }

  /*
   * A fresh key per RENDER of the form.
   *
   * It identifies this checkout attempt, so a customer who taps the button twice
   * sends the same one twice and the second write is refused by a unique index.
   * Reloading the page is a new attempt and gets a new key, which is correct —
   * they really are starting again.
   */
  const idempotencyKey = crypto.randomUUID();

  /*
   * DELIVERY IS PRICED PER GOVERNORATE, AND NOBODY HAS CHOSEN ONE YET.
   *
   * The page is rendered before the form is filled, so the honest quote depends
   * on the table. When every governorate costs the same — which is what a flat
   * rate looks like now — there is one number and it is exact. When they differ,
   * quoting one would be choosing a governorate on the customer's behalf, so the
   * summary says "from" and each option in the list carries its own price.
   *
   * Either way the ORDER is priced from the region that was actually posted, so
   * the total on the confirmation is never a number this page invented.
   */
  const settings = await container.store.getStoreSettings();
  const fees = settings.ok ? settings.value : null;
  const spread = fees === null ? { min: 0, max: 0 } : deliverySpread(fees);
  const oneFeeEverywhere = spread.min === spread.max;
  const feeFor = (region: (typeof REGIONS)[number]): number =>
    fees === null ? 0 : deliveryFeeFor(fees, region);

  const error = one(query.error);
  const errorMessage =
    error === 'phone'
      ? t('errorPhone')
      : error === 'region'
        ? t('errorRegion')
        : error === 'required'
          ? t('errorRequired')
          : error === 'cart'
            ? t('errorCartChanged')
            : error === 'stock'
              ? t('errorStock', { sku: one(query.sku), count: one(query.available) })
              : error === ''
                ? null
                : t('errorGeneric');

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight text-ink">{t('title')}</h1>

      {errorMessage !== null && (
        <p
          role="alert"
          className="rounded-[var(--radius-panel)] border border-negative/60 bg-surface p-5 text-negative"
        >
          {errorMessage}
        </p>
      )}

      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <form action={placeOrder} className="flex flex-col gap-8">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

          <fieldset className="flex flex-col gap-4 border-0 p-0">
            <legend className="pb-2 text-lg font-semibold text-ink">{t('yourDetails')}</legend>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="name" className="text-sm text-muted">
                {t('name')}
              </label>
              <input
                id="name"
                name="name"
                required
                autoComplete="name"
                maxLength={120}
                defaultValue={one(query.name)}
                className={field}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="phone" className="text-sm text-muted">
                {t('phone')}
              </label>
              <input
                id="phone"
                name="phone"
                required
                // tel, not text: a phone keypad on a phone. inputMode as well,
                // because the two are honoured by different browsers.
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                aria-describedby="phone-hint"
                aria-invalid={error === 'phone'}
                defaultValue={one(query.phone)}
                className={field}
              />
              <p id="phone-hint" className="text-xs text-faint">
                {t('phoneHint')}
              </p>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-4 border-0 p-0">
            <legend className="pb-2 text-lg font-semibold text-ink">{t('deliveryTo')}</legend>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="region" className="text-sm text-muted">
                {t('region')}
              </label>
              <select
                id="region"
                name="region"
                required
                defaultValue={one(query.region)}
                aria-invalid={error === 'region'}
                className={field}
              >
                <option value="">—</option>
                {REGIONS.map((region) => (
                  // The price is IN the option. No JavaScript, no reload, and the
                  // cost is in front of the customer at the moment they choose.
                  <option key={region} value={region}>
                    {oneFeeEverywhere
                      ? tRegion(region)
                      : `${tRegion(region)} — ${feeFor(region) === 0 ? t('free') : money(feeFor(region))}`}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="city" className="text-sm text-muted">
                {t('city')}
              </label>
              <input
                id="city"
                name="city"
                required
                autoComplete="address-level2"
                maxLength={80}
                defaultValue={one(query.city)}
                className={field}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="street" className="text-sm text-muted">
                {t('street')}
              </label>
              <input
                id="street"
                name="street"
                required
                autoComplete="street-address"
                maxLength={240}
                defaultValue={one(query.street)}
                className={field}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="notes" className="text-sm text-muted">
                {t('notes')}
              </label>
              <textarea
                id="notes"
                name="notes"
                rows={2}
                maxLength={500}
                defaultValue={one(query.notes)}
                className={field}
              />
            </div>
          </fieldset>

          <div className="flex flex-col gap-3">
            <button
              type="submit"
              className="rounded-lg bg-accent px-5 py-3.5 font-medium text-void transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('placeOrder')}
            </button>
            {/*
              Said plainly, next to the button. Nothing is charged now, and the
              customer should know that before they press it rather than after.
            */}
            <p className="text-sm text-muted">{t('codNote')}</p>
          </div>
        </form>

        <aside
          aria-label={t('summary')}
          className="flex h-fit flex-col gap-4 rounded-[var(--radius-panel)] border border-hairline bg-surface p-5"
        >
          <h2 className="text-base font-semibold text-ink">{t('summary')}</h2>

          <ul className="flex flex-col gap-3 text-sm">
            {priced.lines.map((line) => (
              <li key={line.sku} className="flex justify-between gap-3">
                <span className="text-muted">
                  {line.title}
                  <span className="text-faint"> × {line.quantity}</span>
                </span>
                <span className="shrink-0 tabular-nums text-ink">{money(line.lineTotalCents)}</span>
              </li>
            ))}
          </ul>

          <dl className="flex flex-col gap-2 border-hairline border-t pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">{t('subtotal')}</dt>
              <dd className="tabular-nums text-ink">{money(priced.subtotalCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">{t('delivery')}</dt>
              <dd className="tabular-nums text-ink">
                {oneFeeEverywhere
                  ? spread.min === 0
                    ? t('free')
                    : money(spread.min)
                  : t('deliveryByRegion')}
              </dd>
            </div>
            <div className="flex justify-between border-hairline border-t pt-2 text-base font-semibold">
              <dt className="text-ink">{t('total')}</dt>
              <dd className="tabular-nums text-ink">
                {oneFeeEverywhere
                  ? money(priced.subtotalCents + spread.min)
                  : t('totalFrom', { amount: money(priced.subtotalCents + spread.min) })}
              </dd>
            </div>
          </dl>

          <a
            href={`/${locale}/cart`}
            className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t('backToCart')}
          </a>
        </aside>
      </div>
    </main>
  );
}
