import { MAX_PAGE_SIZE, productPath } from '@modules/catalog';
import { LOCALES } from '@platform/locale';
import type { MetadataRoute } from 'next';
import { getContainer } from '@/composition';

/**
 * sitemap.xml, with hreflang alternates on every entry.
 *
 * The plan calls for hreflang in the sitemap specifically, and this is why: a
 * page can only declare alternates for itself, so a crawler learns about the
 * Arabic version of a product only after fetching the English one. Declaring the
 * set here means all three are discovered together, which is the difference
 * between an Arabic product page being indexed in weeks rather than months.
 *
 * Only ACTIVE products appear. listProducts defaults to active-only and the
 * status parameter cannot widen it, so a draft cannot leak into the sitemap even
 * if someone changes the call.
 */
/*
 * Generated per request, not at build time.
 *
 * A statically generated sitemap is a snapshot of the catalogue at deploy time:
 * every product added afterwards is invisible to crawlers until the next
 * redeploy. For a store whose catalogue is loaded by spreadsheet import rather
 * than by shipping code, that is most of them.
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const container = await getContainer();
  const { siteUrl } = container.config;

  const absolute = (path: string) => `${siteUrl}${path}`;

  /** The hreflang block Next renders as xhtml:link alternates. */
  const languagesFor = (path: (locale: (typeof LOCALES)[number]) => string) => ({
    languages: Object.fromEntries(LOCALES.map((locale) => [locale, absolute(path(locale))])),
  });

  const staticEntries: MetadataRoute.Sitemap = [
    {
      url: absolute('/en'),
      changeFrequency: 'daily',
      priority: 1,
      alternates: languagesFor((locale) => `/${locale}`),
    },
    {
      url: absolute('/en/products'),
      changeFrequency: 'daily',
      priority: 0.9,
      alternates: languagesFor((locale) => `/${locale}/products`),
    },
  ];

  /*
   * Paginate rather than asking for everything at once. MAX_PAGE_SIZE is the
   * ceiling the use case enforces, so a growing catalogue cannot turn sitemap
   * generation into one unbounded query that times out the whole route.
   */
  const products: { slug: string; updatedAt: Date }[] = [];
  let cursor: string | undefined;

  do {
    const page = await container.catalog.listProducts({
      limit: MAX_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!page.ok) break;

    for (const product of page.value.products) {
      products.push({ slug: product.slug, updatedAt: product.updatedAt });
    }
    cursor = page.value.nextCursor ?? undefined;
  } while (cursor !== undefined);

  const productEntries: MetadataRoute.Sitemap = products.map((product) => ({
    url: absolute(productPath('en', product.slug)),
    lastModified: product.updatedAt,
    changeFrequency: 'weekly',
    priority: 0.8,
    alternates: languagesFor((locale) => productPath(locale, product.slug)),
  }));

  return [...staticEntries, ...productEntries];
}
