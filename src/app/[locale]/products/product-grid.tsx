import type { Collection } from '@modules/catalog';
import {
  defaultVariant,
  hasPriceRange,
  isOnOffer,
  priceRange,
  productPath,
  toQuickView,
} from '@modules/catalog';
import type { Locale } from '@platform/locale';
import { textFor } from '@platform/locale';
import { format } from '@platform/money';
import { FacetGroup, type FacetOption, FacetPanel, SearchBox } from '@ui/primitives/facet-panel';
import { Panel } from '@ui/primitives/panel';
import { Price, PriceFrom } from '@ui/primitives/price';
import { Badge, ProductCard } from '@ui/primitives/product-card';
import { connection } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getContainer } from '@/composition';
import { QuickViewProvider, QuickViewTrigger } from './quick-view';
import {
  hasActiveFilters,
  parseListingParams,
  type RawSearchParams,
  toggledHref,
  withCursor,
} from './search-params';

/**
 * The grid itself: await one use case, render the result.
 *
 * No business logic here on purpose — which variant is quoted, whether a product
 * is on offer, and whether drafts are visible are all decided in the domain and
 * the use case, where they are tested at 100%.
 */
export const ProductGrid = async ({
  locale,
  searchParams,
  collection,
  basePath,
}: {
  locale: Locale;
  searchParams: Promise<RawSearchParams>;
  /**
   * When present, the grid lists this collection instead of the whole
   * catalogue. Everything else — search box, facets, pagination, empty states —
   * is identical, which is the reason a collection is modelled as a saved query
   * rather than as its own listing path.
   */
  collection?: Collection;
  /** The URL facet links are built against. Defaults to the products listing. */
  basePath?: string;
}) => {
  await connection();

  const params = parseListingParams(await searchParams);

  const t = await getTranslations({ locale, namespace: 'products' });

  let page: Awaited<ReturnType<typeof loadPage>>;
  try {
    page = await loadPage(params, collection);
  } catch {
    return (
      <Panel>
        <p className="text-sm text-negative">{t('loadFailed')}</p>
      </Panel>
    );
  }

  if (!page.ok) {
    return (
      <Panel>
        <p className="text-sm text-negative">{t('loadFailed')}</p>
      </Panel>
    );
  }

  const base = basePath ?? `/${locale}/products`;
  const filtering = hasActiveFilters(params);
  const { facets } = page.value;
  const now = new Date();

  const brandOptions: FacetOption[] = facets.brands.map((facet) => ({
    value: facet.value,
    label: facet.value,
    count: facet.count,
    href: toggledHref(base, params, { kind: 'brand' }, facet.value),
    selected: params.brands.includes(facet.value),
  }));

  const sidebar = (
    <FacetPanel
      label={t('filters')}
      clearLabel={t('clearFilters')}
      {...(filtering ? { clearHref: base } : {})}
    >
      <FacetGroup legend={t('brand')} options={brandOptions} selectedLabel={t('selected')} />
      {facets.options.map((option) => (
        <FacetGroup
          key={option.name}
          legend={option.name}
          selectedLabel={t('selected')}
          options={option.values.map((value) => ({
            value: value.value,
            label: value.value,
            count: value.count,
            href: toggledHref(base, params, { kind: 'option', name: option.name }, value.value),
            selected:
              params.options
                .find((selected) => selected.name === option.name)
                ?.values.includes(value.value) ?? false,
          }))}
        />
      ))}
    </FacetPanel>
  );

  return (
    <div className="flex flex-col gap-8">
      <SearchBox
        action={base}
        label={t('searchLabel')}
        placeholder={t('searchPlaceholder')}
        submitLabel={t('searchSubmit')}
        defaultValue={params.q}
      />

      <div className="grid gap-10 lg:grid-cols-[16rem_1fr]">
        {sidebar}

        <div className="flex flex-col gap-8">
          {/*
            An empty catalogue and an over-filtered one need different words: one
            says "come back later", the other says "widen your filters". Showing
            the same sentence for both is how a customer concludes the shop is
            empty when it is not.
          */}
          {page.value.products.length === 0 ? (
            <Panel>
              <p className="text-sm text-muted">{filtering ? t('noMatches') : t('empty')}</p>
              {filtering && (
                <p className="mt-3">
                  <a
                    href={base}
                    className="text-sm text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {t('clearFilters')}
                  </a>
                </p>
              )}
            </Panel>
          ) : (
            <>
              <p className="text-sm text-faint" role="status">
                {t('resultCount', { count: page.value.products.length })}
              </p>

              {/*
                The quick-view data is built HERE, from products already loaded
                to render the tiles, and shipped with the page. Fetching it when
                a dialog opens would add a round trip to the one interaction
                whose whole point is not having to wait for one.
              */}
              <QuickViewProvider
                locale={locale}
                views={page.value.products.map((product) => toQuickView(product, { locale, now }))}
                labels={{
                  quickView: t('quickView'),
                  quickViewOf: t.raw('quickViewOf'),
                  close: t('close'),
                  fullDetails: t('fullDetails'),
                  hint: t('quickViewHint'),
                  priceWas: t('priceWas'),
                  priceNow: t('priceNow'),
                  offerEnds: t.raw('offerEnds'),
                  chooseOption: t.raw('chooseOption'),
                  sku: t('sku'),
                }}
              >
                <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
                  {page.value.products.map((product) => {
                    const cheapest = defaultVariant(product);
                    const onOffer = isOnOffer(cheapest, now);
                    const image = product.media.find((item) => item.kind === 'image');

                    return (
                      <li key={product.id}>
                        <ProductCard
                          href={productPath(locale, product.slug)}
                          title={textFor(product.title, locale)}
                          brand={product.brand}
                          image={
                            image === undefined
                              ? null
                              : { src: image.url, alt: textFor(image.alt, locale) }
                          }
                          badge={onOffer ? <Badge tone="caution">{t('sale')}</Badge> : undefined}
                          action={
                            <QuickViewTrigger
                              slug={product.slug}
                              href={productPath(locale, product.slug)}
                            />
                          }
                          price={
                            hasPriceRange(product) ? (
                              <PriceFrom
                                size="sm"
                                label={t('priceFrom', {
                                  price: format(priceRange(product).from, locale),
                                })}
                              />
                            ) : (
                              <Price
                                size="sm"
                                locale={locale}
                                amount={cheapest.price}
                                compareAt={onOffer ? cheapest.compareAtPrice : null}
                                labelWas={t('priceWas')}
                                labelNow={t('priceNow')}
                              />
                            )
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              </QuickViewProvider>

              {page.value.nextCursor !== null && (
                <nav className="flex justify-center" aria-label={t('pagination')}>
                  {/*
                    A real link, not a button: the next page has a URL, so it can
                    be shared, opened in a new tab, crawled, and reached without
                    JavaScript.
                  */}
                  <a
                    href={withCursor(base, params, page.value.nextCursor)}
                    className="rounded-full border border-hairline px-6 py-3 text-sm font-medium text-ink transition-colors hover:border-accent-dim hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {t('loadMore')}
                  </a>
                </nav>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const loadPage = async (params: ReturnType<typeof parseListingParams>, collection?: Collection) => {
  const container = await getContainer();
  const input = {
    ...(params.q.length > 0 ? { search: params.q } : {}),
    ...(params.brands.length > 0 ? { brands: params.brands } : {}),
    ...(params.options.length > 0 ? { options: params.options } : {}),
    ...(params.minCents === undefined ? {} : { priceMinCents: params.minCents }),
    ...(params.maxCents === undefined ? {} : { priceMaxCents: params.maxCents }),
    ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
  };

  return collection === undefined
    ? container.catalog.searchProducts(input)
    : container.catalog.getCollectionProducts(collection, input);
};
