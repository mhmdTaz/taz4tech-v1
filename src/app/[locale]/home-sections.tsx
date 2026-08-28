import {
  defaultVariant,
  hasPriceRange,
  isOnOffer,
  priceRange,
  productPath,
} from '@modules/catalog';
import { type Locale, textFor } from '@platform/locale';
import { format } from '@platform/money';
import { Price, PriceFrom } from '@ui/primitives/price';
import { ProductCard } from '@ui/primitives/product-card';
import { connection } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getContainer } from '@/composition';

/**
 * The two rows of the home page that come out of the database.
 *
 * Each sits behind its own Suspense boundary in page.tsx, so the hero and the
 * assurances beside it are in the response immediately and a slow query delays
 * one strip rather than the page. Both call `connection()` for the reason the
 * whole app does: a build machine has no business reading a catalogue to
 * generate a page, and `pnpm build:offline` fails loudly if one of these forgets.
 *
 * If a query fails, the section renders nothing. A home page missing a row is a
 * home page; a home page showing an error where the products should be is a shop
 * that looks broken to somebody deciding whether to trust it with an address.
 */

const HOW_MANY_NEW = 4;

export const CollectionStrip = async ({ locale }: { locale: Locale }) => {
  await connection();

  const t = await getTranslations({ locale, namespace: 'home' });
  const container = await getContainer();
  const collections = await container.catalog.listCollections();

  if (collections.length === 0) return null;

  return (
    <section aria-labelledby="collections-heading" className="flex flex-col gap-5">
      <SectionHeading
        id="collections-heading"
        title={t('collectionsHeading')}
        body={t('collectionsBody')}
      />

      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {collections.map((collection) => (
          <li key={collection.id}>
            <a
              href={`/${locale}/collections/${collection.slug}`}
              className="group flex h-full flex-col gap-2 rounded-[var(--radius-panel)] border border-hairline bg-surface p-5 transition-colors hover:border-accent-dim focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span className="text-base font-medium text-ink group-hover:text-accent">
                {textFor(collection.title, locale)}
              </span>
              {/*
                The description is optional and often untranslated — textFor falls
                back rather than printing an English sentence in an Arabic page.
              */}
              <span className="text-sm text-muted">{textFor(collection.description, locale)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
};

export const NewArrivals = async ({ locale }: { locale: Locale }) => {
  await connection();

  const t = await getTranslations({ locale, namespace: 'home' });
  const tProducts = await getTranslations({ locale, namespace: 'products' });

  const container = await getContainer();
  const page = await container.catalog.listProducts({ limit: HOW_MANY_NEW });
  if (!page.ok || page.value.products.length === 0) return null;

  /*
   * One clock for the whole strip.
   *
   * Reading `new Date()` per product would let an offer expire between the first
   * tile and the fourth — vanishingly unlikely and impossible to reproduce,
   * which is exactly the kind of bug worth not having.
   */
  const now = container.clock.now();

  return (
    <section aria-labelledby="new-heading" className="flex flex-col gap-5">
      <SectionHeading id="new-heading" title={t('newHeading')} body={t('newBody')} />

      <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
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
                price={
                  hasPriceRange(product) ? (
                    <PriceFrom
                      size="sm"
                      label={tProducts('priceFrom', {
                        price: format(priceRange(product).from, locale),
                      })}
                    />
                  ) : (
                    <Price
                      size="sm"
                      locale={locale}
                      amount={cheapest.price}
                      compareAt={onOffer ? cheapest.compareAtPrice : null}
                      labelWas={tProducts('priceWas')}
                      labelNow={tProducts('priceNow')}
                    />
                  )
                }
              />
            </li>
          );
        })}
      </ul>

      <a
        href={`/${locale}/products`}
        className="self-start text-sm text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {t('seeAll')}
      </a>
    </section>
  );
};

const SectionHeading = ({ id, title, body }: { id: string; title: string; body: string }) => (
  <div className="flex flex-col gap-1">
    <h2 id={id} className="text-2xl font-semibold tracking-tight text-ink">
      {title}
    </h2>
    <p className="max-w-[60ch] text-sm text-muted">{body}</p>
  </div>
);

/** A quiet placeholder of the right height, so nothing jumps when a strip lands. */
export const StripSkeleton = ({ rows = 1 }: { rows?: number }) => (
  <div
    aria-hidden="true"
    className={`rounded-[var(--radius-panel)] bg-surface/40 ${rows === 1 ? 'h-48' : 'h-80'}`}
  />
);
