import {
  buildBreadcrumbStructuredData,
  buildProductStructuredData,
  defaultVariant,
  findVariant,
  isOnOffer,
  optionValues,
  type Product,
  productPath,
  type Variant,
} from '@modules/catalog';
import { availabilityOf, countToShow, type StockMap } from '@modules/inventory';
import type { Locale } from '@platform/locale';
import { textFor } from '@platform/locale';
import { Price } from '@ui/primitives/price';
import { Badge } from '@ui/primitives/product-card';
import { SpecTable } from '@ui/primitives/spec-table';
import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { getContainer } from '@/composition';
import { AddToCart } from '../../cart/add-to-cart';

/**
 * Product detail.
 *
 * Variant selection is a URL, not client state: each option value is a link that
 * sets ?variant=<sku>. That makes every combination shareable, crawlable, and
 * usable with JavaScript disabled or still downloading — which on a Lebanese
 * mobile connection is a meaningful slice of the first paint.
 */
export const ProductDetail = async ({
  product,
  locale,
  stock,
  cartQuantity,
  selectedSku,
  selectedImage,
}: {
  product: Product;
  locale: Locale;
  /** SKU -> level. A SKU that is absent is uncounted, which reads as available. */
  stock: StockMap;
  /** SKU -> how many are already in the cart. */
  cartQuantity: ReadonlyMap<string, number>;
  selectedSku?: string;
  /** Which picture the gallery is showing, from `?image=`. Clamped, never trusted. */
  selectedImage?: number;
}) => {
  const t = await getTranslations({ locale, namespace: 'products' });
  const now = new Date();

  const selected: Variant =
    product.variants.find((variant) => variant.sku === selectedSku) ?? defaultVariant(product);

  const onOffer = isOnOffer(selected, now);
  const images = product.media.filter((item) => item.kind === 'image');

  /*
   * The gallery is a URL, like the variant picker beside it.
   *
   * `?image=2` is shareable, crawlable, survives a reload and works with no
   * JavaScript — the same reasons variant selection is a link rather than client
   * state. The index is clamped rather than validated: `?image=99` shows the
   * first picture, because a query string a customer can edit should never be
   * able to produce a page with no photograph on it.
   */
  const imageIndex =
    selectedImage !== undefined && selectedImage >= 0 && selectedImage < images.length
      ? selectedImage
      : 0;
  const hero = images[imageIndex];

  const selectedAvailability = availabilityOf(stock.get(selected.sku) ?? null);
  const unitsLeft = countToShow(stock.get(selected.sku) ?? null);

  /*
   * The AGGREGATE is in stock if ANY variant is.
   *
   * A multi-variant product emits one AggregateOffer, and the product really is
   * obtainable while a single size remains. Marking the whole thing OutOfStock
   * because one colour ran out would delist a product that can be bought; the
   * per-variant truth is on the page itself, where the customer is choosing.
   */
  const anySellable = product.variants.some(
    (variant) => availabilityOf(stock.get(variant.sku) ?? null) === 'in_stock',
  );

  const crumbs = [
    { name: t('home'), path: `/${locale}` },
    { name: t('title'), path: `/${locale}/products` },
    { name: textFor(product.title, locale), path: productPath(locale, product.slug) },
  ];

  const { config } = await getContainer();
  const breadcrumbData = buildBreadcrumbStructuredData(crumbs, config.siteUrl);
  const structuredData = buildProductStructuredData(
    product,
    {
      siteUrl: config.siteUrl,
      locale,
      availability: anySellable ? 'InStock' : 'OutOfStock',
    },
    now,
  );

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-12 px-6 py-16">
      {/*
        An ordered list, not a row of links. The order IS the information — it is
        a path — and a screen reader announcing "list of 3" then walking it is
        how a breadcrumb is meant to be heard. The separators are decoration and
        marked as such, so they are not read aloud between every crumb.
      */}
      <nav aria-label={t('breadcrumb')} className="text-sm">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;

            return (
              <li key={crumb.path} className="flex items-center gap-2">
                {index > 0 && (
                  <span aria-hidden="true" className="text-faint">
                    /
                  </span>
                )}
                {last ? (
                  // The page you are on is not a link to itself.
                  <span aria-current="page" className="text-faint">
                    {crumb.name}
                  </span>
                ) : (
                  <a
                    href={crumb.path}
                    className="text-muted underline-offset-4 hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {crumb.name}
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="grid gap-12 lg:grid-cols-2">
        <section aria-label={t('gallery')} className="flex flex-col gap-4">
          <div className="relative aspect-4/3 overflow-hidden rounded-[var(--radius-panel)] border border-hairline bg-raised">
            {hero === undefined ? (
              <div
                aria-hidden="true"
                className="h-full w-full bg-linear-to-br from-raised to-surface"
              />
            ) : (
              <Image
                src={hero.url}
                alt={textFor(hero.alt, locale)}
                fill
                // The hero IS the largest contentful paint on this page, so it
                // is fetched eagerly and given a fetchpriority hint — which is
                // what `priority` sets, along with skipping lazy loading.
                priority
                sizes="(min-width: 1024px) 50vw, 100vw"
                className="object-cover"
              />
            )}
          </div>

          {images.length > 1 && (
            /*
              Every image, including the one on show, so the strip does not
              reshuffle as you move through it — a gallery whose thumbnails
              change position when you click one is a gallery you lose your place
              in. The current one is marked rather than removed.
            */
            <ul className="grid grid-cols-4 gap-3">
              {images.map((image, index) => {
                const current = index === imageIndex;

                return (
                  <li key={image.url}>
                    <a
                      href={galleryHref(locale, product.slug, index, selectedSku)}
                      aria-current={current ? 'true' : undefined}
                      // The alt text is on the picture; the link needs to say
                      // what it DOES, or a screen reader hears the same product
                      // description four times with no way to tell them apart.
                      aria-label={t('viewImage', { index: index + 1 })}
                      className={`relative block aspect-square overflow-hidden rounded-lg border bg-raised transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                        current ? 'border-accent' : 'border-hairline hover:border-accent-dim'
                      }`}
                    >
                      <Image src={image.url} alt="" fill sizes="120px" className="object-cover" />
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-6">
          <header className="flex flex-col gap-3">
            {product.brand !== null && (
              <p className="text-xs uppercase tracking-widest text-faint">{product.brand}</p>
            )}
            <h1 className="text-3xl font-semibold tracking-tight text-ink">
              {textFor(product.title, locale)}
            </h1>
          </header>

          <div className="flex flex-wrap items-center gap-4">
            <Price
              size="lg"
              locale={locale}
              amount={selected.price}
              compareAt={onOffer ? selected.compareAtPrice : null}
              labelWas={t('priceWas')}
              labelNow={t('priceNow')}
            />
            {onOffer && <Badge tone="caution">{t('sale')}</Badge>}
          </div>

          {onOffer && selected.offerEndsAt !== null && (
            // Consumer protection law requires the expiry to be shown, not
            // merely stored — so it is rendered wherever the offer is.
            <p className="text-sm text-caution">
              {t('offerEnds', {
                date: new Intl.DateTimeFormat(locale, {
                  dateStyle: 'long',
                  timeZone: 'Asia/Beirut',
                  numberingSystem: 'latn',
                }).format(selected.offerEndsAt),
              })}
            </p>
          )}

          {product.optionNames.length > 0 && (
            <div className="flex flex-col gap-5">
              {product.optionNames.map((optionName) => (
                <fieldset key={optionName} className="flex flex-col gap-3 border-0 p-0">
                  <legend className="text-sm font-medium text-muted">
                    {t('chooseOption', { option: optionName })}
                  </legend>
                  <ul className="flex flex-wrap gap-2">
                    {optionValues(product, optionName).map((value) => {
                      const target = variantFor(product, selected, optionName, value);
                      const isSelected = selected.options.some(
                        (option) => option.name === optionName && option.value === value,
                      );

                      if (target === null) {
                        // The combination does not exist. Shown as disabled
                        // rather than hidden, so the customer can see that
                        // Silver simply has no 512GB, instead of wondering why
                        // an option vanished when they picked a colour.
                        return (
                          <li key={value}>
                            <span
                              aria-disabled="true"
                              className="inline-block cursor-not-allowed rounded-full border border-hairline px-4 py-2 text-sm text-faint line-through"
                            >
                              {value}
                            </span>
                          </li>
                        );
                      }

                      return (
                        <li key={value}>
                          <a
                            href={`${productPath(locale, product.slug)}?variant=${encodeURIComponent(target.sku)}`}
                            aria-current={isSelected ? 'true' : undefined}
                            className={`inline-block rounded-full border px-4 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                              isSelected
                                ? 'border-accent bg-accent/10 text-accent'
                                : 'border-hairline text-ink hover:border-accent-dim hover:text-accent'
                            }`}
                          >
                            {value}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              ))}
            </div>
          )}

          <p
            // A status region: the answer changes when the customer picks
            // another variant, and that change is the point.
            role="status"
            className={`text-sm font-medium ${
              selectedAvailability === 'in_stock' ? 'text-positive' : 'text-negative'
            }`}
          >
            {selectedAvailability === 'in_stock' ? t('inStock') : t('outOfStock')}
            {/*
              The count is shown only when there IS one. An uncounted SKU prints
              nothing rather than a number nobody can stand behind.
            */}
            {selectedAvailability === 'in_stock' &&
              unitsLeft !== null &&
              unitsLeft <= LOW_STOCK && (
                <span className="text-caution"> · {t('unitsLeft', { count: unitsLeft })}</span>
              )}
          </p>

          {/*
            Shown and refused rather than hidden when out of stock: a control
            that disappears reads as a broken page, while a disabled one beside
            "Out of stock" reads as the shop being honest.
          */}
          <AddToCart
            sku={selected.sku}
            locale={locale}
            returnTo={`${productPath(locale, product.slug)}?variant=${encodeURIComponent(selected.sku)}`}
            disabled={selectedAvailability === 'out_of_stock'}
            quantityInCart={cartQuantity.get(selected.sku) ?? 0}
          />

          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted">{t('sku')}</dt>
              <dd className="font-mono text-ink">{selected.sku}</dd>
            </div>
          </dl>

          <div className="prose-sm max-w-none text-base leading-relaxed text-muted">
            <p>{textFor(product.description, locale)}</p>
          </div>
        </section>
      </div>

      {product.specs.length > 0 && (
        <section aria-labelledby="specs-heading" className="max-w-3xl">
          <h2 id="specs-heading" className="sr-only">
            {t('specifications')}
          </h2>
          <SpecTable
            caption={t('specifications')}
            rows={product.specs.map((spec) => ({
              name: textFor(spec.name, locale),
              value: textFor(spec.value, locale),
              group: spec.group,
            }))}
          />
        </section>
      )}

      {/*
        JSON-LD is built by a tested pure function, not assembled inline. A
        malformed offer block is rejected silently by Merchant Center, and this
        is one of the few channels that actually reaches buyers in this vertical.
      */}
      <script
        type="application/ld+json"
        // JSON-LD has to be injected as raw text; there is no React API for it.
        // The content is serialised from typed domain data with JSON.stringify,
        // never from user input, and every "<" is escaped below so it cannot
        // terminate the script element early.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialised domain data, "<" escaped
        dangerouslySetInnerHTML={{
          // Every "<" becomes <, which JSON parses back to "<" but HTML
          // cannot read as the start of "</script>". Without it a product
          // description containing that string would break out of the element.
          __html: JSON.stringify(structuredData).replaceAll('<', '\\u003c'),
        }}
      />

      {/*
        A second block rather than one @graph. Both are valid, and two means a
        malformed Product cannot take the BreadcrumbList down with it — the
        breadcrumb being the one that actually shows up in the search result.
      */}
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialised domain data, "<" escaped
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(breadcrumbData).replaceAll('<', '\\u003c'),
        }}
      />
    </main>
  );
};

/**
 * A link to one picture, carrying the chosen variant along.
 *
 * Dropping `?variant=` while changing image would silently reset a customer's
 * colour and size, which is the kind of thing that only shows up as an order for
 * the wrong SKU. Image 0 omits the parameter entirely so the first picture is
 * the bare product URL — the one that gets shared and the one that is canonical.
 */
const galleryHref = (
  locale: Locale,
  slug: string,
  index: number,
  selectedSku: string | undefined,
): string => {
  const query = new URLSearchParams();
  if (selectedSku !== undefined) query.set('variant', selectedSku);
  if (index > 0) query.set('image', String(index));

  const path = productPath(locale, slug);
  return query.size === 0 ? path : `${path}?${query.toString()}`;
};

/**
 * Below this, the remaining count is worth showing.
 *
 * "Only 2 left" is a real nudge and a true statement; "Only 47 left" is neither.
 * A constant rather than a setting until someone actually wants to tune it.
 */
const LOW_STOCK = 5;

/**
 * The variant you land on by changing ONE option and keeping the rest.
 *
 * Returns null when that combination does not exist, which is a real case: a
 * matrix is frequently incomplete — Silver may only come in 256GB.
 */
const variantFor = (
  product: Product,
  current: Variant,
  optionName: string,
  value: string,
): Variant | null =>
  // findVariant lives in the domain and is tested there. Re-implementing the
  // option-matching here would mean two definitions of "same combination" that
  // could drift apart without either one failing.
  findVariant(
    product,
    current.options.map((option) => (option.name === optionName ? { ...option, value } : option)),
  );
