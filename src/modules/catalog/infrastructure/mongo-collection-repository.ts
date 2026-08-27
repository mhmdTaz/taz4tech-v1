/**
 * Mongo adapter for CollectionRepository.
 *
 * Same two rules as the product repository: storeId in every filter, and Zod on
 * the way out rather than a cast.
 */

import type { Db, Collection as MongoCollection } from 'mongodb';
import { z } from 'zod';
import type { CollectionRepository, ListCollectionsQuery } from '../contracts';
import {
  COLLECTION_SORTS,
  COLLECTION_STATUSES,
  type Collection,
  type CollectionId,
  compareForNavigation,
  createCollection,
} from '../domain/collection';
import type { ProductId } from '../domain/product';

export const COLLECTIONS_COLLECTION = 'collections';

const LocalizedTextDocument = z.object({
  en: z.string(),
  ar: z.string().optional(),
  fr: z.string().optional(),
});

const RulesDocument = z.object({
  brands: z.array(z.string()).optional(),
  options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).optional(),
  priceMinCents: z.number().int().optional(),
  priceMaxCents: z.number().int().optional(),
});

const CollectionDocument = z.object({
  _id: z.string(),
  storeId: z.string(),
  slug: z.string(),
  title: LocalizedTextDocument,
  description: LocalizedTextDocument,
  status: z.enum(COLLECTION_STATUSES),
  rules: RulesDocument,
  pinnedProductIds: z.array(z.string()),
  sort: z.enum(COLLECTION_SORTS),
  position: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

type CollectionDocumentShape = z.infer<typeof CollectionDocument>;

/** Rebuild LocalizedText with absent locales omitted rather than set to undefined. */
const localized = (doc: z.infer<typeof LocalizedTextDocument>) => {
  const text: { en: string; ar?: string; fr?: string } = { en: doc.en };
  if (doc.ar !== undefined) text.ar = doc.ar;
  if (doc.fr !== undefined) text.fr = doc.fr;
  return text;
};

/** Same for the rules, whose optional keys must be absent rather than undefined. */
const rulesOf = (doc: z.infer<typeof RulesDocument>) => {
  const rules: {
    brands?: string[];
    options?: { name: string; values: string[] }[];
    priceMinCents?: number;
    priceMaxCents?: number;
  } = {};
  if (doc.brands !== undefined) rules.brands = doc.brands;
  if (doc.options !== undefined) rules.options = doc.options;
  if (doc.priceMinCents !== undefined) rules.priceMinCents = doc.priceMinCents;
  if (doc.priceMaxCents !== undefined) rules.priceMaxCents = doc.priceMaxCents;
  return rules;
};

const toDomain = (raw: unknown, context: string): Collection => {
  const parsed = CollectionDocument.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`collection document ${context} is malformed: ${parsed.error.message}`);
  }
  const doc = parsed.data;

  const collection = createCollection({
    storeId: doc.storeId,
    id: doc._id as CollectionId,
    slug: doc.slug,
    title: localized(doc.title),
    description: localized(doc.description),
    status: doc.status,
    rules: rulesOf(doc.rules),
    pinnedProductIds: doc.pinnedProductIds as ProductId[],
    sort: doc.sort,
    position: doc.position,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });

  if (!collection.ok) {
    throw new Error(
      `collection document ${context} violates a domain invariant: ${JSON.stringify(collection.error)}`,
    );
  }
  return collection.value;
};

const toDocument = (collection: Collection): CollectionDocumentShape => ({
  _id: collection.id,
  storeId: collection.storeId,
  slug: collection.slug,
  title: collection.title,
  description: collection.description,
  status: collection.status,
  rules: {
    ...(collection.rules.brands === undefined ? {} : { brands: [...collection.rules.brands] }),
    ...(collection.rules.options === undefined
      ? {}
      : {
          options: collection.rules.options.map((option) => ({
            name: option.name,
            values: [...option.values],
          })),
        }),
    ...(collection.rules.priceMinCents === undefined
      ? {}
      : { priceMinCents: collection.rules.priceMinCents }),
    ...(collection.rules.priceMaxCents === undefined
      ? {}
      : { priceMaxCents: collection.rules.priceMaxCents }),
  },
  pinnedProductIds: [...collection.pinnedProductIds],
  sort: collection.sort,
  position: collection.position,
  createdAt: collection.createdAt,
  updatedAt: collection.updatedAt,
});

export const createMongoCollectionRepository = (db: Db): CollectionRepository => {
  const collection: MongoCollection<CollectionDocumentShape> =
    db.collection(COLLECTIONS_COLLECTION);

  return {
    async findBySlug(storeId, slug) {
      const doc = await collection.findOne({ storeId, slug });
      return doc === null ? null : toDomain(doc, `${storeId}/${slug}`);
    },

    async findById(storeId, id) {
      const doc = await collection.findOne({ storeId, _id: id });
      return doc === null ? null : toDomain(doc, `${storeId}/${id}`);
    },

    async list(query: ListCollectionsQuery) {
      const filter: Record<string, unknown> = { storeId: query.storeId };
      if (query.status !== undefined) filter.status = query.status;

      const docs = await collection.find(filter).sort({ position: 1 }).toArray();
      // Sorted again in the domain, because the tiebreak (title) is a domain
      // rule and Mongo cannot apply it across locales the way the domain does.
      return docs
        .map((doc) => toDomain(doc, `${query.storeId}/${doc.slug}`))
        .sort(compareForNavigation);
    },

    async save(value) {
      const document = toDocument(value);
      await collection.replaceOne({ _id: document._id, storeId: document.storeId }, document, {
        upsert: true,
      });
    },
  };
};

export const ensureCollectionIndexes = async (db: Db): Promise<void> => {
  const collection = db.collection(COLLECTIONS_COLLECTION);
  await collection.createIndex(
    { storeId: 1, slug: 1 },
    { unique: true, name: 'storeId_slug_unique' },
  );
  // Serves the navigation query in sort order.
  await collection.createIndex(
    { storeId: 1, status: 1, position: 1 },
    { name: 'storeId_status_position' },
  );
};
