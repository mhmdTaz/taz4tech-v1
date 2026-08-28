import {
  defaultVariant,
  hasPriceRange,
  isOnOffer,
  type Product,
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
 * "More from Lenovo", under the product.
 *
 * Brand, not a hand-curated list and not a recommendation engine. A shop with a
 * few hundred products and no purchase history has nothing to build a
 * recommendation from — and the brand is the thing a customer looking at a
 * Lenovo laptop is most likely to want more of. It is honest about what it is:
 * the heading names the brand.
 *
 * A product with no brand gets no strip. There is no sensible fallback that is
 * not a lie about why these four are here.
 *
 * Behind its own Suspense boundary in the page, so this second query never
 * delays the product a customer came to read.
 */

const HOW_MANY = 4;

export const RelatedProducts = async ({
  product,
  locale,
}: {
  product: Product;
  locale: Locale;
}) => {
  await connection();

  if (product.brand === null) return null;

  const t = await getTranslations({ locale, namespace: 'products' });
  const container = await getContainer();

  /*
   * One more than needed, because this product is almost certainly in its own
   * results. Asking for four and filtering would leave three whenever it is.
   */
  const found = await container.catalog.searchProducts({
    brands: [product.brand],
    limit: HOW_MANY + 1,
  });
  if (!found.ok) return null;

  const others = found.value.products.filter((each) => each.id !== product.id).slice(0, HOW_MANY);
  if (others.length === 0) return null;

  const now = container.clock.now();

  return (
    <section aria-labelledby="related-heading" className="flex flex-col gap-5">
      <h2 id="related-heading" className="text-2xl font-semibold tracking-tight text-ink">
        {t('relatedHeading', { brand: product.brand })}
      </h2>

      <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {others.map((each) => {
          const cheapest = defaultVariant(each);
          const onOffer = isOnOffer(cheapest, now);
          const image = each.media.find((item) => item.kind === 'image');

          return (
            <li key={each.id}>
              <ProductCard
                href={productPath(locale, each.slug)}
                title={textFor(each.title, locale)}
                brand={each.brand}
                image={
                  image === undefined ? null : { src: image.url, alt: textFor(image.alt, locale) }
                }
                price={
                  hasPriceRange(each) ? (
                    <PriceFrom
                      size="sm"
                      label={t('priceFrom', { price: format(priceRange(each).from, locale) })}
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
    </section>
  );
};
