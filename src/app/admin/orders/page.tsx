import { ORDER_STATUSES, type OrderStatus } from '@modules/orders';
import { format as formatMoney } from '@platform/money';
import { formatForDisplay } from '@platform/phone';
import { getContainer } from '@/composition';
import { logOut } from '../login/actions';
import { requireAdmin } from '../session';
import { StatusChip } from './status-chip';

/** Reads a cookie and the database on every request. */
export const dynamic = 'force-dynamic';

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const asStatus = (value: string | undefined): OrderStatus | undefined =>
  value !== undefined && (ORDER_STATUSES as readonly string[]).includes(value)
    ? (value as OrderStatus)
    : undefined;

const cell = 'px-3 py-3 text-start align-top';
const headCell = `${cell} font-medium text-faint`;

/** Beirut, always — the shop and every customer are in one timezone. */
const when = (date: Date): string =>
  new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Beirut',
    numberingSystem: 'latn',
  }).format(date);

export default async function AdminOrdersPage({ searchParams }: PageProps) {
  // On the page itself, not the layout. See ../session.ts.
  await requireAdmin();

  const params = await searchParams;
  const status = asStatus(one(params.status));
  const cursor = one(params.cursor);

  const container = await getContainer();
  const page = await container.orders.listOrders({
    ...(status === undefined ? {} : { status }),
    ...(cursor === undefined ? {} : { cursor }),
  });

  const link = (extra: Record<string, string>) => {
    const query = new URLSearchParams(extra);
    return `/admin/orders${query.size === 0 ? '' : `?${query.toString()}`}`;
  };

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Orders</h1>
          <p className="text-sm text-muted">Newest first. Call the customer, then confirm.</p>
        </div>

        <div className="flex items-center gap-3">
          <a
            href="/admin/products"
            className="rounded-lg border border-hairline px-3 py-2 text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Products
          </a>
          <form action={logOut}>
            <button
              type="submit"
              className="rounded-lg border border-hairline px-3 py-2 text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      {/*
        Links, not a form: each filter is a URL the operator can bookmark, and
        "show me today's pending orders" is a thing they will want back tomorrow.
      */}
      <nav aria-label="Filter by status" className="flex flex-wrap gap-2">
        <a
          href={link({})}
          aria-current={status === undefined ? 'true' : undefined}
          className={`rounded-full border px-3 py-1.5 text-sm ${
            status === undefined
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-hairline text-muted hover:text-ink'
          } focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
        >
          All
        </a>
        {ORDER_STATUSES.map((value) => (
          <a
            key={value}
            href={link({ status: value })}
            aria-current={status === value ? 'true' : undefined}
            className={`rounded-full border px-3 py-1.5 text-sm ${
              status === value
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-hairline text-muted hover:text-ink'
            } focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
          >
            {value}
          </a>
        ))}
      </nav>

      {page.orders.length === 0 ? (
        <p className="rounded-[var(--radius-panel)] border border-hairline bg-surface p-8 text-sm text-muted">
          {status === undefined ? 'No orders yet.' : 'No orders with that status.'}
        </p>
      ) : (
        <>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable */}
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="w-full min-w-160 border-collapse text-sm">
              <caption className="sr-only">Orders, newest first</caption>
              <thead>
                <tr className="border-hairline border-b">
                  <th scope="col" className={headCell}>
                    Order
                  </th>
                  <th scope="col" className={headCell}>
                    Placed
                  </th>
                  <th scope="col" className={headCell}>
                    Customer
                  </th>
                  <th scope="col" className={headCell}>
                    Items
                  </th>
                  <th scope="col" className={headCell}>
                    Total
                  </th>
                  <th scope="col" className={headCell}>
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.orders.map((order) => (
                  <tr key={order.id} className="border-hairline/60 border-b last:border-b-0">
                    <th scope="row" className={`${cell} font-normal`}>
                      <a
                        href={`/admin/orders/${encodeURIComponent(order.number)}`}
                        className="font-mono text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {order.number}
                      </a>
                    </th>
                    <td className={`${cell} text-muted`}>{when(order.placedAt)}</td>
                    <td className={`${cell} text-ink`}>
                      {order.customer.name}
                      <span className="block font-mono text-xs text-faint">
                        {formatForDisplay(order.customer.phone)}
                      </span>
                    </td>
                    <td className={`${cell} tabular-nums text-muted`}>
                      {order.lines.reduce((total, line) => total + line.quantity, 0)}
                    </td>
                    <td className={`${cell} tabular-nums text-ink`}>
                      {formatMoney(order.total, 'en')}
                    </td>
                    <td className={cell}>
                      <StatusChip status={order.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {page.nextCursor !== null && (
            <a
              href={link({
                ...(status === undefined ? {} : { status }),
                cursor: page.nextCursor,
              })}
              className="self-start rounded-lg border border-hairline px-4 py-2 text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Show older
            </a>
          )}
        </>
      )}
    </main>
  );
}
