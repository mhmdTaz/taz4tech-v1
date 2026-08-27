import { PRODUCT_STATUSES, type ProductStatus } from '@modules/catalog';
import { notFound } from 'next/navigation';
import { getContainer } from '@/composition';
import { logOut } from '../login/actions';
import { requireAdmin } from '../session';
import { BulkEditor, type ProductRow } from './bulk-editor';

/** Reads a cookie, a flag and the database. Nothing here is prerenderable. */
export const dynamic = 'force-dynamic';

/** Big enough that a supplier delivery fits on one screen. */
const PAGE_SIZE = 60;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const asStatus = (value: string | undefined): ProductStatus | undefined =>
  value !== undefined && (PRODUCT_STATUSES as readonly string[]).includes(value)
    ? (value as ProductStatus)
    : undefined;

export default async function AdminProductsPage({ searchParams }: PageProps) {
  // The gate sits on the page, not on the layout above it. See ../session.ts.
  await requireAdmin();

  const container = await getContainer();
  if (!container.flags.isOn('excelImporter')) notFound();

  const params = await searchParams;
  const query = first(params.q)?.trim() ?? '';
  const status = asStatus(first(params.status));

  const result = await container.catalog.searchProducts({
    limit: PAGE_SIZE,
    // The admin is the only caller that ever sets this, and it is the ONLY way
    // to widen visibility — passing a status alone would still return actives.
    includeUnpublished: true,
    ...(query.length > 0 ? { search: query } : {}),
    ...(status === undefined ? {} : { status }),
  });

  /*
   * A rejected query is the operator's own filter being out of bounds, not a
   * server fault. Showing an empty list with the reason beats a 500 that loses
   * everything else on the page.
   */
  const products = result.ok ? result.value.products : [];
  const problem = result.ok ? null : 'That filter is out of range.';

  const rows: ProductRow[] = products.map((product) => {
    const prices = product.variants.map((variant) => variant.price.cents);
    return {
      id: product.id,
      slug: product.slug,
      title: product.title.en,
      status: product.status,
      brand: product.brand,
      priceFromCents: prices.reduce((low, cents) => (cents < low ? cents : low)),
      priceToCents: prices.reduce((high, cents) => (cents > high ? cents : high)),
      variantCount: product.variants.length,
      onOfferVariants: product.variants.filter((variant) => variant.compareAtPrice !== null).length,
    };
  });

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Products</h1>
          <p className="text-sm text-muted">
            Select products, choose a change, check what it would do, then apply.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <a
            href="/admin/import"
            className="rounded-lg border border-hairline px-3 py-2 text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Import
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
        A plain GET form, so filtering works with no JavaScript and every filtered
        view is a URL that can be bookmarked or sent to someone.
      */}
      <search>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5 text-sm text-muted">
            <label htmlFor="q">Search</label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={query}
              placeholder="Title, brand or SKU"
              className="w-64 rounded-lg border border-hairline bg-raised px-3 py-2 text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
          </div>

          <div className="flex flex-col gap-1.5 text-sm text-muted">
            {/* Sibling, not parent: a wrapping label folds every option into the
                control's accessible name. */}
            <label htmlFor="status">Status</label>
            <select
              id="status"
              name="status"
              defaultValue={status ?? ''}
              className="rounded-lg border border-hairline bg-raised px-3 py-2 text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <option value="">Any</option>
              {PRODUCT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            className="rounded-lg border border-hairline px-4 py-2 text-sm text-ink hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Filter
          </button>
        </form>
      </search>

      {problem !== null && (
        <p
          role="alert"
          className="rounded-panel border border-negative/60 bg-surface p-5 text-negative"
        >
          {problem}
        </p>
      )}

      <BulkEditor rows={rows} statuses={PRODUCT_STATUSES} pageSize={PAGE_SIZE} />
    </main>
  );
}
