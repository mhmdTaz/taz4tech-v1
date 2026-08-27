/**
 * Mongo adapter for ProductRepository.
 *
 * Two rules this file exists to hold:
 *
 * 1. storeId is in every filter, without exception. Enforcing multi-tenancy at
 *    the repository layer means no use case can forget it, because no use case
 *    ever writes a query.
 * 2. Documents are parsed with Zod on the way out, never cast. A document
 *    written by an older version of the code is untrusted input; `as Product`
 *    would let a missing field travel to a rendered page as `undefined`.
 *
 * The ULID product id is stored as `_id`, which buys three things at once: the
 * uniqueness constraint, a chronological sort with no extra index, and a cursor
 * that is stable while products are being published.
 */

import type { LocalizedText } from '@platform/locale';
import { fromCents } from '@platform/money';
import { err, ok } from '@platform/result';
import type { Collection, Db } from 'mongodb';
import { z } from 'zod';
import type {
  Facets,
  FacetValue,
  ListProductsQuery,
  OptionFacet,
  ProductFilters,
  ProductPage,
  ProductRepository,
  SaveConflict,
  SearchProductsQuery,
  SearchResult,
} from '../contracts';
import { createProduct, PRODUCT_STATUSES, type Product, type ProductId } from '../domain/product';
import { expandSearchTerms, normaliseSearchText } from '../domain/search';

export const PRODUCTS_COLLECTION = 'products';

/** Money crosses the boundary as integer cents plus a currency, never a float. */
const MoneyDocument = z.object({
  cents: z.number().int(),
  currency: z.literal('USD'),
});

const LocalizedTextDocument = z.object({
  en: z.string(),
  ar: z.string().optional(),
  fr: z.string().optional(),
});

const VariantDocument = z.object({
  sku: z.string(),
  options: z.array(z.object({ name: z.string(), value: z.string() })),
  price: MoneyDocument,
  compareAtPrice: MoneyDocument.nullable(),
  offerEndsAt: z.date().nullable(),
  barcode: z.string().nullable(),
  weightGrams: z.number().nullable(),
});

const ProductDocument = z.object({
  _id: z.string(),
  storeId: z.string(),
  slug: z.string(),
  title: LocalizedTextDocument,
  description: LocalizedTextDocument,
  brand: z.string().nullable(),
  status: z.enum(PRODUCT_STATUSES),
  optionNames: z.array(z.string()),
  variants: z.array(VariantDocument).min(1),
  media: z.array(
    z.object({
      kind: z.enum(['image', 'video']),
      url: z.string(),
      alt: LocalizedTextDocument,
      width: z.number().nullable(),
      height: z.number().nullable(),
    }),
  ),
  specs: z.array(
    z.object({
      name: LocalizedTextDocument,
      value: LocalizedTextDocument,
      group: z.string().nullable(),
    }),
  ),
  createdAt: z.date(),
  updatedAt: z.date(),
  /**
   * Derived on write: every searchable string, normalised.
   *
   * Optional in the schema because documents written before this field existed
   * are still valid products — refusing to load them would take the catalogue
   * down for a search feature.
   */
  searchText: z.string().optional(),
});

type ProductDocumentShape = z.infer<typeof ProductDocument>;

/**
 * Rebuild LocalizedText with absent locales OMITTED rather than set to
 * undefined. Under exactOptionalPropertyTypes those are different types, and the
 * distinction is load-bearing: `{ ar: undefined }` has an `ar` key, so any check
 * written as `'ar' in text` would call an untranslated product translated.
 */
const localized = (doc: z.infer<typeof LocalizedTextDocument>): LocalizedText => {
  const text: { en: string; ar?: string; fr?: string } = { en: doc.en };
  if (doc.ar !== undefined) text.ar = doc.ar;
  if (doc.fr !== undefined) text.fr = doc.fr;
  return text;
};

const money = (doc: z.infer<typeof MoneyDocument>) => {
  const result = fromCents(doc.cents, doc.currency);
  if (!result.ok) throw new Error(`stored amount is not valid money: ${JSON.stringify(doc)}`);
  return result.value;
};

/**
 * Rehydrate a stored document into a domain Product.
 *
 * Re-runs every domain invariant rather than trusting what is on disk. A product
 * written before a rule existed is exactly the case that would otherwise reach a
 * customer — so a document that cannot satisfy the current rules is a loud
 * failure, not a silently rendered page.
 *
 * `createdAt` is passed as `now` deliberately: offer end dates were validated as
 * future-dated when written, and re-checking them against the present would make
 * every past offer un-loadable.
 */
const toDomain = (raw: unknown, context: string): Product => {
  const parsed = ProductDocument.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`product document ${context} is malformed: ${parsed.error.message}`);
  }
  const doc = parsed.data;

  const product = createProduct(
    {
      storeId: doc.storeId,
      id: doc._id as ProductId,
      slug: doc.slug,
      title: localized(doc.title),
      description: localized(doc.description),
      brand: doc.brand,
      status: doc.status,
      optionNames: doc.optionNames,
      variants: doc.variants.map((variant) => ({
        ...variant,
        price: money(variant.price),
        compareAtPrice: variant.compareAtPrice === null ? null : money(variant.compareAtPrice),
      })),
      media: doc.media.map((item) => ({ ...item, alt: localized(item.alt) })),
      specs: doc.specs.map((spec) => ({
        ...spec,
        name: localized(spec.name),
        value: localized(spec.value),
      })),
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    },
    doc.createdAt,
  );

  if (!product.ok) {
    throw new Error(
      `product document ${context} violates a domain invariant: ${JSON.stringify(product.error)}`,
    );
  }
  return product.value;
};

/**
 * Everything a customer might reasonably type, in one normalised string.
 *
 * Built on write rather than matched at read time: a regex over several fields
 * cannot use an index, and the text index this feeds is what keeps search off a
 * collection scan.
 */
const buildSearchText = (product: Product): string => {
  const parts: string[] = [product.slug];
  if (product.brand !== null) parts.push(product.brand);

  for (const text of [product.title, product.description]) {
    for (const value of Object.values(text)) if (typeof value === 'string') parts.push(value);
  }
  for (const variant of product.variants) {
    parts.push(variant.sku);
    if (variant.barcode !== null) parts.push(variant.barcode);
    for (const option of variant.options) parts.push(option.name, option.value);
  }
  for (const spec of product.specs) {
    for (const text of [spec.name, spec.value]) {
      for (const value of Object.values(text)) if (typeof value === 'string') parts.push(value);
    }
  }

  return normaliseSearchText(parts.join(' '));
};

const toDocument = (product: Product): ProductDocumentShape => ({
  _id: product.id,
  storeId: product.storeId,
  slug: product.slug,
  title: product.title,
  description: product.description,
  brand: product.brand,
  status: product.status,
  optionNames: [...product.optionNames],
  variants: product.variants.map((variant) => ({
    sku: variant.sku,
    options: variant.options.map((option) => ({ ...option })),
    price: { cents: variant.price.cents, currency: variant.price.currency },
    compareAtPrice:
      variant.compareAtPrice === null
        ? null
        : { cents: variant.compareAtPrice.cents, currency: variant.compareAtPrice.currency },
    offerEndsAt: variant.offerEndsAt,
    barcode: variant.barcode,
    weightGrams: variant.weightGrams,
  })),
  media: product.media.map((item) => ({ ...item })),
  specs: product.specs.map((spec) => ({ ...spec })),
  createdAt: product.createdAt,
  updatedAt: product.updatedAt,
  searchText: buildSearchText(product),
});

/**
 * Filter fragments, one per facet, so each can be applied or omitted.
 *
 * Keyed by facet so a facet's own selection can be excluded when counting it —
 * see the note on ProductRepository.search.
 */
const filterFragments = (filters: ProductFilters): Map<string, Record<string, unknown>> => {
  const fragments = new Map<string, Record<string, unknown>>();

  if (filters.brands !== undefined && filters.brands.length > 0) {
    fragments.set('brand', { brand: { $in: [...filters.brands] } });
  }

  const min = filters.priceMinCents;
  const max = filters.priceMaxCents;
  if (min !== undefined || max !== undefined) {
    const bounds: Record<string, number> = {};
    if (min !== undefined) bounds.$gte = min;
    if (max !== undefined) bounds.$lte = max;
    // elemMatch, not a bare path: without it a product with a $50 variant and a
    // $500 variant matches "under $100" on one variant and "over $400" on the
    // other, and appears under both filters at once.
    fragments.set('price', { variants: { $elemMatch: { 'price.cents': bounds } } });
  }

  for (const option of filters.options ?? []) {
    if (option.values.length === 0) continue;
    fragments.set(`option:${option.name}`, {
      variants: {
        $elemMatch: {
          options: { $elemMatch: { name: option.name, value: { $in: [...option.values] } } },
        },
      },
    });
  }

  return fragments;
};

/** Every fragment except the named one, combined. */
const combine = (
  fragments: ReadonlyMap<string, Record<string, unknown>>,
  except?: string,
): Record<string, unknown> => {
  const clauses: Record<string, unknown>[] = [];
  for (const [key, fragment] of fragments) if (key !== except) clauses.push(fragment);
  return clauses.length === 0 ? {} : { $and: clauses };
};

const toFacetValues = (rows: { _id: unknown; count: number }[]): FacetValue[] =>
  rows
    .filter((row): row is { _id: string; count: number } => typeof row._id === 'string')
    .map((row) => ({ value: row._id, count: row.count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

/**
 * The clauses every facet must respect: tenant, status, search terms, and the
 * collection a page is scoped to.
 *
 * Collection membership belongs HERE rather than in a facet fragment, because it
 * is not something the customer can toggle. Put it in a fragment and "Laptops"
 * would report brand counts drawn from the whole catalogue, offering filters
 * that return nothing.
 */
const buildBaseMatch = (query: SearchProductsQuery): Record<string, unknown> => {
  const base: Record<string, unknown> = { storeId: query.storeId };
  if (query.status !== undefined) base.status = query.status;

  const search = query.filters.search;
  if (search !== undefined && search.trim().length > 0) {
    const { terms } = expandSearchTerms(search);
    // Space-separated terms are OR in a $text search, which is exactly what
    // synonym expansion wants: any of them is a hit.
    if (terms.length > 0) base.$text = { $search: terms.join(' ') };
  }

  const membership = query.membership;
  if (membership !== undefined) {
    const ruleFragments = [...filterFragments(membership.rules).values()];
    const clauses: Record<string, unknown>[] = [];
    if (ruleFragments.length > 0) clauses.push({ $and: ruleFragments });
    if (membership.pinnedProductIds.length > 0) {
      clauses.push({ _id: { $in: [...membership.pinnedProductIds] } });
    }
    // No clauses would match everything, turning an empty collection into the
    // whole catalogue. The domain forbids that shape; this is the second line.
    base.$or = clauses.length > 0 ? clauses : [{ _id: { $in: [] } }];
  }

  return base;
};

/** One $facet branch per SELECTED option axis, each ignoring its own filter. */
const buildOptionBranches = (
  fragments: ReadonlyMap<string, Record<string, unknown>>,
  optionNames: readonly string[],
): Record<string, unknown[]> => {
  const branches: Record<string, unknown[]> = {};
  for (const name of optionNames) {
    branches[`option_${name}`] = [
      { $match: combine(fragments, `option:${name}`) },
      { $unwind: '$variants' },
      { $unwind: '$variants.options' },
      { $match: { 'variants.options.name': name } },
      // addToSet on the product id, so a product with three Black variants
      // counts once against Black rather than three times.
      { $group: { _id: '$variants.options.value', count: { $addToSet: '$_id' } } },
      { $project: { count: { $size: '$count' } } },
    ];
  }
  return branches;
};

/** Turn the $facet output into the Facets the application layer expects. */
const readFacets = (
  branch: (name: string) => unknown[],
  optionNames: readonly string[],
): Facets => {
  const otherRows = branch('optionsOther') as {
    _id: { name?: unknown; value?: unknown };
    count: number;
  }[];

  const byName = new Map<string, { _id: unknown; count: number }[]>();
  for (const row of otherRows) {
    const name = row._id?.name;
    const value = row._id?.value;
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    // A selected axis is counted by its own branch, which ignores its own
    // filter; drop it from the generic results.
    if (optionNames.includes(name)) continue;
    const rows = byName.get(name) ?? [];
    rows.push({ _id: value, count: row.count });
    byName.set(name, rows);
  }

  for (const name of optionNames) {
    byName.set(name, branch(`option_${name}`) as { _id: unknown; count: number }[]);
  }

  const options: OptionFacet[] = [];
  for (const [name, rows] of byName) {
    const values = toFacetValues(rows);
    if (values.length > 0) options.push({ name, values });
  }

  const priceRow = (branch('price') as { minCents?: number; maxCents?: number }[])[0];

  return {
    brands: toFacetValues(branch('brands') as { _id: unknown; count: number }[]),
    options: options.sort((a, b) => a.name.localeCompare(b.name)),
    priceRange:
      priceRow?.minCents === undefined || priceRow.maxCents === undefined
        ? null
        : { minCents: priceRow.minCents, maxCents: priceRow.maxCents },
  };
};

/** Mongo's code for "a unique index refused this". */
const DUPLICATE_KEY = 11000;

/**
 * Read a driver error as a uniqueness conflict, or null if it is something else.
 *
 * The index NAME is not used to decide which conflict it is — keyValue is,
 * because it names the field that actually collided. Matching on the index name
 * would silently stop working the day an index is renamed, and it would report
 * the wrong field for a compound index that grows a column.
 */
const asDuplicateKey = (error: unknown): SaveConflict | null => {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; keyValue?: Record<string, unknown> };
  if (candidate.code !== DUPLICATE_KEY) return null;

  const sku = candidate.keyValue?.['variants.sku'];
  if (typeof sku === 'string') return { tag: 'sku_taken', sku };

  const slug = candidate.keyValue?.slug;
  if (typeof slug === 'string') return { tag: 'slug_taken', slug };

  // A duplicate key on an index we do not know about is not something to
  // swallow: it means an index exists that this code has no story for.
  return null;
};

export const createMongoProductRepository = (db: Db): ProductRepository => {
  const collection: Collection<ProductDocumentShape> = db.collection(PRODUCTS_COLLECTION);

  return {
    async findBySlug(storeId, slug) {
      const doc = await collection.findOne({ storeId, slug });
      return doc === null ? null : toDomain(doc, `${storeId}/${slug}`);
    },

    async findById(storeId, id) {
      const doc = await collection.findOne({ storeId, _id: id });
      return doc === null ? null : toDomain(doc, `${storeId}/${id}`);
    },

    async findBySku(storeId, sku) {
      const doc = await collection.findOne({ storeId, 'variants.sku': sku });
      return doc === null ? null : toDomain(doc, `${storeId}/sku:${sku}`);
    },

    async findByIds(storeId, ids) {
      if (ids.length === 0) return [];
      // _id is the primary key, so this is an IXSCAN by construction.
      const docs = await collection.find({ storeId, _id: { $in: [...ids] } }).toArray();
      return docs.map((doc) => toDomain(doc, `${storeId}/${doc.slug}`));
    },

    async findBySkus(storeId, skus) {
      if (skus.length === 0) return [];
      // Served by storeId_sku_unique; the integration test asserts on the plan.
      const docs = await collection.find({ storeId, 'variants.sku': { $in: [...skus] } }).toArray();
      return docs.map((doc) => toDomain(doc, `${storeId}/${doc.slug}`));
    },

    async findBySlugs(storeId, slugs) {
      if (slugs.length === 0) return [];
      // $in over the {storeId, slug} unique index: one round trip for the whole
      // import rather than one per row.
      const docs = await collection.find({ storeId, slug: { $in: [...slugs] } }).toArray();
      return docs.map((doc) => toDomain(doc, `${storeId}/${doc.slug}`));
    },

    async list(query: ListProductsQuery): Promise<ProductPage> {
      /*
       * Newest first, paginated on _id. Because the id is a ULID its first 10
       * characters are a millisecond timestamp, so _id descending IS newest
       * first — no secondary sort key and no extra index.
       */
      const filter: Record<string, unknown> = { storeId: query.storeId };
      if (query.status !== undefined) filter.status = query.status;
      if (query.cursor !== undefined) filter._id = { $lt: query.cursor };

      // One extra row tells us whether another page exists without a count().
      const docs = await collection
        .find(filter)
        .sort({ _id: -1 })
        .limit(query.limit + 1)
        .toArray();

      const hasMore = docs.length > query.limit;
      const page = hasMore ? docs.slice(0, query.limit) : docs;

      return {
        products: page.map((doc) => toDomain(doc, `${query.storeId}/${doc._id}`)),
        nextCursor: hasMore ? (page[page.length - 1]?._id ?? null) : null,
      };
    },

    async search(query: SearchProductsQuery): Promise<SearchResult> {
      const fragments = filterFragments(query.filters);
      const optionNames = [...new Set((query.filters.options ?? []).map((o) => o.name))];
      const pageMatch = combine(fragments);
      const cursorClause = query.cursor === undefined ? {} : { _id: { $lt: query.cursor } };

      const [result] = await collection
        .aggregate<Record<string, unknown[]>>([
          { $match: buildBaseMatch(query) },
          {
            $facet: {
              page: [
                { $match: { ...pageMatch, ...cursorClause } },
                { $sort: { _id: -1 } },
                { $limit: query.limit + 1 },
              ],
              brands: [
                { $match: combine(fragments, 'brand') },
                { $group: { _id: '$brand', count: { $sum: 1 } } },
              ],
              /*
               * Counts for every axis that is NOT currently filtered, with all
               * filters applied — so choosing a brand narrows the colours, which
               * is what makes faceted browsing feel like it is responding.
               */
              optionsOther: [
                { $match: pageMatch },
                { $unwind: '$variants' },
                { $unwind: '$variants.options' },
                {
                  $group: {
                    _id: { name: '$variants.options.name', value: '$variants.options.value' },
                    products: { $addToSet: '$_id' },
                  },
                },
                { $project: { count: { $size: '$products' } } },
              ],
              price: [
                { $match: combine(fragments, 'price') },
                { $unwind: '$variants' },
                {
                  $group: {
                    _id: null,
                    minCents: { $min: '$variants.price.cents' },
                    maxCents: { $max: '$variants.price.cents' },
                  },
                },
              ],
              ...buildOptionBranches(fragments, optionNames),
            },
          },
        ])
        .toArray();

      const branch = (name: string): unknown[] => (result?.[name] ?? []) as unknown[];

      const docs = branch('page') as ProductDocumentShape[];
      const hasMore = docs.length > query.limit;
      const page = hasMore ? docs.slice(0, query.limit) : docs;

      return {
        products: page.map((doc) => toDomain(doc, `${query.storeId}/${doc._id}`)),
        nextCursor: hasMore ? (page[page.length - 1]?._id ?? null) : null,
        facets: readFacets(branch, optionNames),
      };
    },

    async save(product) {
      const document = toDocument(product);
      try {
        await collection.replaceOne({ _id: document._id, storeId: document.storeId }, document, {
          upsert: true,
        });
        return ok(undefined);
      } catch (error) {
        /*
         * Translating a driver error into a domain-shaped one is exactly this
         * layer's job. Above here nothing knows what 11000 means, and nothing
         * should — an application layer that reads Mongo error codes is coupled
         * to Mongo through the back door.
         *
         * Anything that is NOT a uniqueness conflict is rethrown. A dropped
         * connection is not an expected outcome of importing a spreadsheet, and
         * swallowing it would report a successful import that wrote nothing.
         */
        const conflict = asDuplicateKey(error);
        if (conflict === null) throw error;
        return err(conflict);
      }
    },
  };
};

/** Called once at startup. Idempotent — createIndex is a no-op if it already exists. */
export const ensureProductIndexes = async (db: Db): Promise<void> => {
  const collection = db.collection(PRODUCTS_COLLECTION);
  await collection.createIndex(
    { storeId: 1, slug: 1 },
    { unique: true, name: 'storeId_slug_unique' },
  );
  // Serves the listing query and its cursor in one index, in sort order.
  await collection.createIndex({ storeId: 1, status: 1, _id: -1 }, { name: 'storeId_status_id' });
  // A SKU identifies exactly one variant across the whole store — the importer
  // relies on it to decide insert versus update.
  await collection.createIndex(
    { storeId: 1, 'variants.sku': 1 },
    { unique: true, name: 'storeId_sku_unique' },
  );

  /*
   * One text index per collection, over the derived searchText field.
   *
   * default_language 'none' turns stemming OFF, deliberately. Stemmers are
   * per-language and Arabic is not among the supported set, so leaving it on
   * would stem the English half of a bilingual catalogue and do nothing useful
   * for the other half. normaliseSearchText has already folded both sides into
   * the same shape, which is the part that actually matters here.
   */
  await collection.createIndex(
    { searchText: 'text' },
    { name: 'searchText_text', default_language: 'none' },
  );
};
