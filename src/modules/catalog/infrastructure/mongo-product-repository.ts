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
import type { Collection, Db } from 'mongodb';
import { z } from 'zod';
import type { ListProductsQuery, ProductPage, ProductRepository } from '../contracts';
import { createProduct, PRODUCT_STATUSES, type Product, type ProductId } from '../domain/product';

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
});

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

    async save(product) {
      const document = toDocument(product);
      await collection.replaceOne({ _id: document._id, storeId: document.storeId }, document, {
        upsert: true,
      });
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
};
