import {
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
import { getTranslations } from 'next-intl/server';
import { getContainer } from '@/composition';

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
  selectedSku,
}: {
  product: Product;
  locale: Locale;
  /** SKU -> level. A SKU that is absent is uncounted, which reads as available. */
  stock: StockMap;
  selectedSku?: string;
}) => {
  const t = await getTranslations({ locale, namespace: 'products' });
  const now = new Date();

  const selected: Variant =
    product.variants.find((variant) => variant.sku === selectedSku) ?? defaultVariant(product);

  const onOffer = isOnOffer(selected, now);
  const images = product.media.filter((item) => item.kind === 'image');
  const hero = images[0];

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

  const { config } = await getContainer();
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
      <nav aria-label={t('breadcrumb')} className="text-sm">
        <a
          href={`/${locale}/products`}
          className="text-muted underline-offset-4 hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t('title')}
        </a>
      </nav>

      <div className="grid gap-12 lg:grid-cols-2">
        <section aria-label={t('gallery')} className="flex flex-col gap-4">
          <div className="aspect-4/3 overflow-hidden rounded-[var(--radius-panel)] border border-hairline bg-raised">
            {hero === undefined ? (
              <div
                aria-hidden="true"
                className="h-full w-full bg-linear-to-br from-raised to-surface"
              />
            ) : (
              // See the note in ui/primitives/product-card.tsx.
              // biome-ignore lint/performance/noImgElement: media hosts are a Phase 3 settings decision
              <img
                src={hero.url}
                alt={textFor(hero.alt, locale)}
                className="h-full w-full object-cover"
                // The hero is the largest contentful paint on this page, so it
                // is fetched eagerly rather than lazily.
                fetchPriority="high"
                decoding="async"
              />
            )}
          </div>

          {images.length > 1 && (
            <ul className="grid grid-cols-4 gap-3">
              {images.slice(1).map((image) => (
                <li
                  key={image.url}
                  className="aspect-square overflow-hidden rounded-lg border border-hairline bg-raised"
                >
                  {/* biome-ignore lint/performance/noImgElement: media hosts are a Phase 3 settings decision */}
                  <img
                    src={image.url}
                    alt={textFor(image.alt, locale)}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                </li>
              ))}
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
    </main>
  );
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
