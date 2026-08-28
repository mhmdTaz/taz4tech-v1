import type { Order } from '@modules/orders';
import { secretsMatch } from '@platform/auth';
import { isLocale, type Locale } from '@platform/locale';
import { format as formatMoney } from '@platform/money';
import { formatForDisplay } from '@platform/phone';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getContainer } from '@/composition';

export const dynamic = 'force-dynamic';

type PageProps = {
  params: Promise<{ locale: string; number: string }>;
  searchParams: Promise<{ t?: string | string[] }>;
};

/**
 * Whether this request is allowed to read this order.
 *
 * Constant-time, because a byte-by-byte comparison of a secret leaks how much
 * of it a guess got right, and 130 bits guessed one character at a time is not
 * 130 bits.
 */
const mayRead = async (order: Order, supplied: string | undefined): Promise<boolean> => {
  if (order.viewToken === null) return true;
  if (supplied === undefined) return false;
  return secretsMatch(supplied, order.viewToken);
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};

  const t = await getTranslations({ locale, namespace: 'checkout' });
  /*
   * noindex, and it matters more here than anywhere else on the site.
   *
   * This page carries a customer's name, phone number and street address. An
   * order number is guessable — they are sequential — so this is deliberately
   * kept out of search results, where a crawler would otherwise publish one
   * person's address against a URL anybody can enumerate.
   */
  return { title: t('metaTitle'), robots: { index: false, follow: false, nocache: true } };
}

/**
 * The confirmation page.
 *
 * THE NUMBER IDENTIFIES THE ORDER; THE TOKEN AUTHORISES READING IT
 * ----------------------------------------------------------------
 * There are no accounts, so there is nothing to authenticate against, and the
 * customer has to be able to reload this page, hand it to whoever is paying,
 * and come back to it from a WhatsApp message days later. A URL is the only
 * credential that survives all three.
 *
 * It used to be the order number alone — and those are sequential, so anyone
 * who could count could read a stranger's name, phone number and street
 * address. The token in `?t=` is 130 bits from the CSPRNG, stored on the order,
 * compared in constant time, and issued exactly once: in the redirect after
 * checkout.
 *
 * A WRONG TOKEN IS A 404, NOT A 403
 * ---------------------------------
 * Identical to an order that does not exist. "Forbidden" would confirm that
 * T4T-26-000042 is real, which is the one fact enumeration is looking for, and
 * would turn this page into an oracle for how many orders the shop has taken.
 *
 * ORDERS WITH NO TOKEN ARE STILL READABLE
 * ---------------------------------------
 * Anything placed before the field existed has `viewToken === null`. Those
 * links are already in people's messages and cannot be reissued, so they keep
 * working. It is a hole that stops growing rather than one that stays open.
 */
export default async function OrderConfirmationPage({ params, searchParams }: PageProps) {
  const { locale, number } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  await connection();

  const container = await getContainer();
  const order = await container.orders.findByNumber(decodeURIComponent(number));
  if (order === null) notFound();

  const supplied = (await searchParams).t;
  if (!(await mayRead(order, Array.isArray(supplied) ? supplied[0] : supplied))) notFound();

  const t = await getTranslations({ locale, namespace: 'checkout' });
  const tRegion = await getTranslations({ locale, namespace: 'region' });
  const money = (cents: number) => formatMoney({ cents, currency: order.total.currency }, locale);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">
          {t('thanksTitle', { number: order.number })}
        </h1>
        <p className="text-base text-muted">
          {t('thanksBody', { phone: formatForDisplay(order.customer.phone) })}
        </p>
      </header>

      <section className="flex flex-col gap-2 rounded-[var(--radius-panel)] border border-accent/40 bg-surface p-5">
        <p className="text-xs uppercase tracking-widest text-faint">{t('orderNumber')}</p>
        {/*
          Selectable, monospaced and large: this is the thing the customer reads
          out on the phone, so it has to survive being copied and being spoken.
        */}
        <p className="select-all font-mono text-2xl font-semibold text-accent">{order.number}</p>
        <p className="text-sm text-muted">{t('keepNumber')}</p>
      </section>

      <Summary
        order={order}
        locale={locale}
        money={money}
        regionLabel={tRegion(order.delivery.region)}
      />

      <a
        href={`/${locale}/products`}
        className="self-start rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {t('continueShopping')}
      </a>
    </main>
  );
}

const Summary = async ({
  order,
  locale,
  money,
  regionLabel,
}: {
  order: Order;
  locale: Locale;
  money: (cents: number) => string;
  regionLabel: string;
}) => {
  const t = await getTranslations({ locale, namespace: 'checkout' });

  return (
    <section
      aria-label={t('summary')}
      className="flex flex-col gap-4 rounded-[var(--radius-panel)] border border-hairline bg-surface p-5"
    >
      <h2 className="text-base font-semibold text-ink">{t('summary')}</h2>

      <ul className="flex flex-col gap-3 text-sm">
        {order.lines.map((line) => (
          <li key={line.sku} className="flex justify-between gap-3">
            <span className="text-muted">
              {line.title}
              {line.options.length > 0 && (
                <span className="text-faint">
                  {' '}
                  ({line.options.map((option) => option.value).join(', ')})
                </span>
              )}
              <span className="text-faint"> × {line.quantity}</span>
            </span>
            <span className="shrink-0 tabular-nums text-ink">{money(line.lineTotal.cents)}</span>
          </li>
        ))}
      </ul>

      <dl className="flex flex-col gap-2 border-hairline border-t pt-4 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">{t('subtotal')}</dt>
          <dd className="tabular-nums text-ink">{money(order.subtotal.cents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">{t('delivery')}</dt>
          <dd className="tabular-nums text-ink">
            {order.deliveryFee.cents === 0 ? t('free') : money(order.deliveryFee.cents)}
          </dd>
        </div>
        <div className="flex justify-between border-hairline border-t pt-2 text-base font-semibold">
          <dt className="text-ink">{t('total')}</dt>
          <dd className="tabular-nums text-ink">{money(order.total.cents)}</dd>
        </div>
      </dl>

      <div className="border-hairline border-t pt-4 text-sm">
        <p className="text-xs uppercase tracking-widest text-faint">{t('deliveryTo')}</p>
        <address className="not-italic text-muted">
          {order.customer.name}
          <br />
          {order.delivery.street}
          <br />
          {order.delivery.city}, {regionLabel}
          {order.delivery.notes !== null && (
            <>
              <br />
              <span className="text-faint">{order.delivery.notes}</span>
            </>
          )}
        </address>
      </div>

      <p className="text-sm text-muted">{t('codNote')}</p>
    </section>
  );
};
