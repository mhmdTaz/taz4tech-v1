import { type Product, productPath } from '@modules/catalog';
import { isLocale, LOCALES, type Locale, textFor } from '@platform/locale';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { cache } from 'react';
import { getContainer } from '@/composition';
import { readCart } from '../../cart/cookie';
import { ProductDetail } from './product-detail';

type PageProps = {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ variant?: string }>;
};

/**
 * Loaded once per request, not twice.
 *
 * generateMetadata and the page body both need the product. React's cache()
 * dedupes them within a request, so a product page costs one query instead of
 * two — which on a cash-on-delivery storefront is the difference between a fast
 * page and paying Atlas twice for every visit.
 */
const loadProduct = cache(async (slug: string): Promise<Product | null> => {
  const container = await getContainer();
  const result = await container.catalog.getProductBySlug(slug);
  return result.ok ? result.value : null;
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};

  const product = await loadProduct(slug);
  if (product === null) {
    const t = await getTranslations({ locale, namespace: 'products' });
    return { title: t('notFoundTitle') };
  }

  const title = textFor(product.title, locale);
  const description = textFor(product.description, locale);

  return {
    title,
    description,
    alternates: {
      // Canonical points at the bare product URL, never at a ?variant= one:
      // every variant renders substantially the same page, and letting them
      // compete as separate URLs splits the ranking signals between them.
      canonical: productPath(locale, product.slug),
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [l, productPath(l, product.slug)])),
        'x-default': productPath('en', product.slug),
      },
    },
    openGraph: {
      type: 'website',
      title,
      description,
      locale,
      images: product.media
        .filter((item) => item.kind === 'image')
        .map((item) => ({ url: item.url, alt: textFor(item.alt, locale) })),
    },
  };
}

export default async function ProductPage({ params, searchParams }: PageProps) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  // Reads a database, so it must not be prerendered at build time.
  await connection();

  const { variant } = await searchParams;
  const product = await loadProduct(slug);

  // Draft, archived and non-existent all render the same 404 on the storefront.
  // The use case still distinguishes them, which is what the admin preview needs.
  if (product === null) notFound();

  /*
   * Stock is a separate module and a separate document, so it is a separate
   * read — one query for this product's SKUs, joined here in the delivery layer
   * rather than by making the catalogue know what stock is.
   */
  const { inventory } = await getContainer();
  const stock = await inventory.getStockLevels(product.variants.map((each) => each.sku));

  // From the cookie, so it costs no query — the cart holds SKUs and quantities.
  const cart = await readCart();
  const cartQuantity = new Map(cart.lines.map((line) => [line.sku, line.quantity]));

  return (
    <ProductDetail
      product={product}
      locale={locale as Locale}
      stock={stock}
      cartQuantity={cartQuantity}
      {...(variant === undefined ? {} : { selectedSku: variant })}
    />
  );
}
