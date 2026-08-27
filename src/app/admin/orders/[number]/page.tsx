import {
  canTransition,
  displayPhone,
  ORDER_STATUSES,
  type Order,
  type OrderStatus,
  whatsAppLink,
} from '@modules/orders';
import { format as formatMoney } from '@platform/money';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getContainer } from '@/composition';
import { requireAdmin } from '../../session';
import { moveOrder } from '../actions';
import { STATUS_LABELS, StatusChip } from '../status-chip';

/** Reads a cookie and the database on every request. */
export const dynamic = 'force-dynamic';

type PageProps = {
  params: Promise<{ number: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/*
 * `includes`, not `value in STATUS_LABELS`. `in` walks the prototype, so
 * `?conflict=toString` would answer yes and hand the page a function to call
 * `.toLowerCase()` on. Query strings are attacker input even on an admin screen.
 */
const asStatus = (value: string | undefined): OrderStatus | undefined =>
  value !== undefined && (ORDER_STATUSES as readonly string[]).includes(value)
    ? (value as OrderStatus)
    : undefined;

/** Beirut, always — the shop and every customer are in one timezone. */
const when = (date: Date): string =>
  new Intl.DateTimeFormat('en', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Asia/Beirut',
    numberingSystem: 'latn',
  }).format(date);

const panel = 'rounded-[var(--radius-panel)] border border-hairline bg-surface p-5';

export default async function AdminOrderPage({ params, searchParams }: PageProps) {
  // On the page itself, not the layout. See ../../session.ts.
  await requireAdmin();

  const { number } = await params;
  const query = await searchParams;

  const container = await getContainer();
  const order = await container.orders.findByNumber(decodeURIComponent(number));
  if (order === null) notFound();

  // Admin chrome is English — the customer's language belongs in the message
  // that goes TO the customer, not in the screen the operator works from.
  const regions = await getTranslations({ locale: 'en', namespace: 'region' });
  const region = regions(order.delivery.region);

  const moved = asStatus(one(query.moved));
  const conflict = one(query.conflict);
  const conflictStatus = asStatus(conflict);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <a
          href="/admin/orders"
          className="self-start text-sm text-muted underline-offset-4 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          ← All orders
        </a>
        <h1 className="flex flex-wrap items-center gap-3 font-mono text-2xl font-semibold tracking-tight text-ink">
          {order.number}
          <StatusChip status={order.status} />
        </h1>
        <p className="text-sm text-muted">Placed {when(order.placedAt)}</p>
      </header>

      {/*
        role="status" and role="alert": the outcome of a form post that redirected.
        Without them a screen reader lands on a page that looks unchanged, because
        the only thing that moved is a sentence near the top.
      */}
      {moved !== undefined && (
        <p
          role="status"
          className="rounded-[var(--radius-panel)] border border-positive/60 bg-surface p-4 text-sm text-positive"
        >
          This order is now {STATUS_LABELS[moved].toLowerCase()}.
          {moved === 'cancelled' && <span className="text-muted"> The stock has gone back.</span>}
        </p>
      )}

      {conflict !== undefined && (
        <p
          role="alert"
          className="rounded-[var(--radius-panel)] border border-caution/60 bg-surface p-4 text-sm text-caution"
        >
          {conflictStatus === undefined
            ? 'That is not a step this order can take.'
            : `Somebody moved this order first — it is ${STATUS_LABELS[
                conflictStatus
              ].toLowerCase()} now.`}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-6">
          <Lines order={order} />
          <Actions order={order} />
        </div>

        <div className="flex flex-col gap-6">
          <Customer order={order} region={region} />
          {container.flags.isOn('whatsappTapToSend') && (
            <WhatsApp order={order} adminRegion={region} />
          )}
        </div>
      </div>
    </main>
  );
}

const Lines = ({ order }: { order: Order }) => (
  <section className={`${panel} flex flex-col gap-4`} aria-labelledby="lines-heading">
    <h2 id="lines-heading" className="text-lg font-semibold text-ink">
      What to pick
    </h2>

    <ul className="flex flex-col gap-3 text-sm">
      {order.lines.map((line) => (
        <li key={line.sku} className="flex justify-between gap-4">
          <span className="text-ink">
            <span className="font-medium tabular-nums">{line.quantity} ×</span> {line.title}
            {line.options.length > 0 && (
              <span className="text-muted">
                {' '}
                ({line.options.map((option) => option.value).join(', ')})
              </span>
            )}
            {/*
              The SKU, monospaced, because this list is read against a shelf and
              a title on its own does not tell two variants apart.
            */}
            <span className="block font-mono text-xs text-faint">{line.sku}</span>
          </span>
          <span className="shrink-0 tabular-nums text-ink">
            {formatMoney(line.lineTotal, 'en')}
          </span>
        </li>
      ))}
    </ul>

    <dl className="flex flex-col gap-2 border-hairline border-t pt-4 text-sm">
      <div className="flex justify-between">
        <dt className="text-muted">Subtotal</dt>
        <dd className="tabular-nums text-ink">{formatMoney(order.subtotal, 'en')}</dd>
      </div>
      <div className="flex justify-between">
        <dt className="text-muted">Delivery</dt>
        <dd className="tabular-nums text-ink">
          {order.deliveryFee.cents === 0 ? 'Free' : formatMoney(order.deliveryFee, 'en')}
        </dd>
      </div>
      <div className="flex justify-between border-hairline border-t pt-2 text-base font-semibold">
        <dt className="text-ink">Collect in cash</dt>
        <dd className="tabular-nums text-accent">{formatMoney(order.total, 'en')}</dd>
      </div>
    </dl>
  </section>
);

const Customer = ({ order, region }: { order: Order; region: string }) => (
  <section className={`${panel} flex flex-col gap-3`} aria-labelledby="customer-heading">
    <h2 id="customer-heading" className="text-lg font-semibold text-ink">
      Deliver to
    </h2>

    <address className="text-sm text-muted not-italic">
      <span className="block font-medium text-ink">{order.customer.name}</span>
      {order.delivery.street}
      <br />
      {order.delivery.city}, {region}
      {order.delivery.notes !== null && (
        <span className="mt-2 block text-caution">{order.delivery.notes}</span>
      )}
    </address>

    {/*
      A tel: link, not text. The operator calls before every delivery, and one
      tap beats reading a number off a screen into a keypad.
    */}
    <a
      href={`tel:${order.customer.phone}`}
      className="self-start rounded-lg border border-hairline px-3 py-2 font-mono text-sm text-ink hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {displayPhone(order)}
    </a>
  </section>
);

const STEPS: readonly {
  readonly to: OrderStatus;
  readonly label: string;
  readonly tone: string;
}[] = [
  { to: 'confirmed', label: 'Confirm', tone: 'bg-accent text-void' },
  { to: 'delivered', label: 'Mark delivered', tone: 'bg-positive text-void' },
  { to: 'cancelled', label: 'Cancel order', tone: 'border border-negative/60 text-negative' },
];

const Actions = ({ order }: { order: Order }) => {
  /*
   * Only the transitions the lifecycle actually allows are offered.
   *
   * The write refuses the rest anyway — the current status is part of the filter,
   * not a check before it — but a button that exists and then refuses teaches an
   * operator to distrust the screen. This is the same rule stated twice, and the
   * one that matters is the one in the database.
   */
  const available = STEPS.filter((step) => canTransition(order.status, step.to));

  if (available.length === 0) {
    return (
      <p className={`${panel} text-sm text-muted`}>
        This order is {STATUS_LABELS[order.status].toLowerCase()}. Nothing left to do.
      </p>
    );
  }

  return (
    <section className={`${panel} flex flex-col gap-3`} aria-labelledby="actions-heading">
      <h2 id="actions-heading" className="text-lg font-semibold text-ink">
        Next step
      </h2>

      <div className="flex flex-wrap gap-3">
        {available.map((step) => (
          // One form per action: a single form with several submit buttons posts
          // the same body whichever one is pressed.
          <form key={step.to} action={moveOrder}>
            <input type="hidden" name="id" value={order.id} />
            <input type="hidden" name="number" value={order.number} />
            {/*
              The status this screen was rendered from. If the order has moved
              since, the post is answered with what it is now instead of with
              "that is not a step this order can take" — which would be true and
              also completely unhelpful.
            */}
            <input type="hidden" name="from" value={order.status} />
            <input type="hidden" name="to" value={step.to} />
            <button
              type="submit"
              className={`rounded-lg px-4 py-2.5 text-sm font-medium transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${step.tone}`}
            >
              {step.label}
            </button>
          </form>
        ))}
      </div>

      {canTransition(order.status, 'cancelled') && (
        <p className="text-sm text-faint">Cancelling puts every line back on the shelf.</p>
      )}
    </section>
  );
};

const WhatsApp = async ({ order, adminRegion }: { order: Order; adminRegion: string }) => {
  /*
   * Written in the customer's language, which the order recorded when it was
   * placed. There is nowhere else to learn it once the request is over.
   *
   * `t.raw` rather than `t`: `greeting` and `intro` carry {name} and {number}
   * placeholders that this layer fills in, so asking next-intl to interpolate
   * them here would mean handing it values it is about to be handed again.
   */
  const t = await getTranslations({ locale: order.locale, namespace: 'whatsapp' });
  const regions = await getTranslations({ locale: order.locale, namespace: 'region' });

  const href = whatsAppLink(order, {
    labels: {
      greeting: t.raw('greeting'),
      intro: t.raw('intro'),
      itemsHeading: t('items'),
      totalLabel: t('total'),
      deliveryLabel: t('delivery'),
      codNote: t('cod'),
      closing: t('closing'),
    },
    formatMoney: (cents) => formatMoney({ cents, currency: order.total.currency }, order.locale),
    regionLabel: regions(order.delivery.region),
  });

  return (
    <section className={`${panel} flex flex-col gap-3`} aria-labelledby="whatsapp-heading">
      <h2 id="whatsapp-heading" className="text-lg font-semibold text-ink">
        WhatsApp
      </h2>

      <a
        href={href}
        target="_blank"
        // noreferrer as well as noopener: the URL carries a customer's name and
        // street address, and that has no business in anyone's referrer log.
        rel="noopener noreferrer"
        className="rounded-lg bg-positive px-4 py-2.5 text-center text-sm font-medium text-void transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Send on WhatsApp
      </a>

      {/*
        Said out loud, because the difference matters: this opens WhatsApp with
        the message written. A person presses send. Nothing here delivers
        anything on its own.
      */}
      <p className="text-sm text-faint">
        Opens WhatsApp with the message written in {order.locale.toUpperCase()} — delivery to{' '}
        {adminRegion}. You press send.
      </p>
    </section>
  );
};
