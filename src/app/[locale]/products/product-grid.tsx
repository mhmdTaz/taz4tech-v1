import {
  defaultVariant,
  hasPriceRange,
  isOnOffer,
  priceRange,
  productPath,
} from '@modules/catalog';
import type { Locale } from '@platform/locale';
import { textFor } from '@platform/locale';
import { format } from '@platform/money';
import { Panel } from '@ui/primitives/panel';
import { Price, PriceFrom } from '@ui/primitives/price';
import { Badge, ProductCard } from '@ui/primitives/product-card';
import { connection } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getContainer } from '@/composition';

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
}: {
  locale: Locale;
  searchParams: Promise<{ cursor?: string }>;
}) => {
  await connection();

  const { cursor } = await searchParams;

  const t = await getTranslations({ locale, namespace: 'products' });

  let page: Awaited<ReturnType<typeof loadPage>>;
  try {
    page = await loadPage(cursor);
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

  if (page.value.products.length === 0) {
    return (
      <Panel>
        <p className="text-sm text-muted">{t('empty')}</p>
      </Panel>
    );
  }

  const now = new Date();

  return (
    <div className="flex flex-col gap-10">
      <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
                  image === undefined ? null : { src: image.url, alt: textFor(image.alt, locale) }
                }
                badge={onOffer ? <Badge tone="caution">{t('sale')}</Badge> : undefined}
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

      {page.value.nextCursor !== null && (
        <nav className="flex justify-center" aria-label={t('pagination')}>
          {/*
            A real link, not a button: the next page has a URL, so it can be
            shared, opened in a new tab, crawled, and reached without JavaScript.
          */}
          <a
            href={`?cursor=${encodeURIComponent(page.value.nextCursor)}`}
            className="rounded-full border border-hairline px-6 py-3 text-sm font-medium text-ink transition-colors hover:border-accent-dim hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t('loadMore')}
          </a>
        </nav>
      )}
    </div>
  );
};

const loadPage = async (cursor?: string) => {
  const container = await getContainer();
  return container.catalog.listProducts(cursor === undefined ? {} : { cursor });
};
