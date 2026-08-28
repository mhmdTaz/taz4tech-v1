/**
 * Public surface of the catalogue module.
 *
 * Everything the rest of the system may know about the catalogue is on this
 * page. The boundary check rejects any import that reaches past it, which is
 * what leaves the folders behind it free to change.
 */

import type { EntityId } from '@platform/ids';
import type { Db } from '@platform/mongo';
import { type BulkEdit, makeBulkEdit } from './application/bulk-edit';
import {
  type GetCollection,
  type GetCollectionProducts,
  type ListCollections,
  makeGetCollection,
  makeGetCollectionProducts,
  makeListCollections,
} from './application/get-collection';
import { type GetProductBySlug, makeGetProductBySlug } from './application/get-product-by-slug';
import { type GetProductsBySkus, makeGetProductsBySkus } from './application/get-products-by-skus';
import { type ImportProducts, makeImportProducts } from './application/import-products';
import { type ListProducts, makeListProducts } from './application/list-products';
import { makeSaveCollection, type SaveCollection } from './application/save-collection';
import { makeSaveProduct, type SaveProduct } from './application/save-product';
import { makeSearchProducts, type SearchProducts } from './application/search-products';
import type { ImageIngestor, StockWriter } from './contracts';
import {
  createMongoCollectionRepository,
  ensureCollectionIndexes,
} from './infrastructure/mongo-collection-repository';
import {
  createMongoProductRepository,
  ensureProductIndexes,
} from './infrastructure/mongo-product-repository';
import { createXlsxWorkbookReader } from './infrastructure/xlsx-workbook-reader';

export type {
  BulkChange,
  BulkChangeView,
  BulkEdit,
  BulkEditError,
  BulkEditInput,
  BulkEditOutput,
  BulkEditReport,
  BulkProductView,
} from './application/bulk-edit';
export { MAX_BULK_SELECTION, toBulkEditReport } from './application/bulk-edit';
export type {
  GetCollection,
  GetCollectionError,
  GetCollectionProducts,
  GetCollectionProductsError,
  ListCollections,
} from './application/get-collection';
export type { GetProductBySlug, GetProductBySlugError } from './application/get-product-by-slug';
export type {
  GetProductsBySkus,
  GetProductsBySkusInput,
} from './application/get-products-by-skus';
export type {
  ColumnMapping,
  ImportField,
  MappingProblem,
} from './application/import/column-mapping';
export {
  detectMapping,
  IMPORT_FIELDS,
  REQUIRED_FIELDS,
  validateMapping,
} from './application/import/column-mapping';
export type {
  ImportReport,
  ProductPreview,
  ProductProblemView,
  RowProblemView,
  ToImportReportInput,
} from './application/import/import-report';
export { SAMPLE_ROW_COUNT, toImportReport } from './application/import/import-report';
export type { CellProblem } from './application/import/parse-cell';
export type {
  ImportPlan,
  PlannedProduct,
  ProductProblem,
  RowProblem,
} from './application/import/plan-import';
export type {
  ImportProducts,
  ImportProductsError,
  ImportProductsInput,
  ImportProductsOutput,
} from './application/import-products';
export type {
  ListProducts,
  ListProductsError,
  ListProductsInput,
} from './application/list-products';
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './application/list-products';
export type {
  Availability,
  ProductStructuredData,
  StructuredDataOptions,
} from './application/product-structured-data';
export {
  buildProductStructuredData,
  productPath,
  productUrl,
} from './application/product-structured-data';
export type {
  QuickView,
  QuickViewOption,
  QuickViewOptions,
  QuickViewVariant,
} from './application/quick-view';
export { toQuickView } from './application/quick-view';
export type { SaveCollection, SaveCollectionError } from './application/save-collection';
export type { SaveProduct, SaveProductError } from './application/save-product';
export type {
  SearchProducts,
  SearchProductsError,
  SearchProductsInput,
} from './application/search-products';
export { MAX_FILTER_VALUES } from './application/search-products';
export type {
  CollectionRepository,
  Facets,
  FacetValue,
  ListCollectionsQuery,
  ListProductsQuery,
  MembershipClause,
  OptionFacet,
  ProductFilters,
  ProductPage,
  ProductRepository,
  SearchProductsQuery,
  SearchResult,
  StockWriteFailure,
  StockWriter,
} from './contracts';
export type { BulkOperation, BulkOutcome, BulkRefusal } from './domain/bulk-edit';
export {
  applyBulkOperation,
  isValidBasisPoints,
  MAX_BASIS_POINTS,
  MIN_BASIS_POINTS,
} from './domain/bulk-edit';
export type {
  Collection,
  CollectionError,
  CollectionId,
  CollectionRules,
  CollectionSort,
  CollectionStatus,
} from './domain/collection';
export {
  COLLECTION_SORTS,
  COLLECTION_STATUSES,
  compareForNavigation,
  createCollection,
  hasRules,
  isFullyCurated,
  isPublished,
} from './domain/collection';
export type {
  Media,
  Product,
  ProductError,
  ProductId,
  ProductStatus,
  Spec,
  Variant,
  VariantOption,
} from './domain/product';
export {
  createProduct,
  defaultVariant,
  findVariant,
  hasPriceRange,
  isOnOffer,
  isPurchasable,
  isValidSlug,
  optionValues,
  PRODUCT_STATUSES,
  priceRange,
  slugify,
} from './domain/product';
export { expandSearchTerms, isSearchable, normaliseSearchText } from './domain/search';

export type CatalogModule = {
  readonly getProductBySlug: GetProductBySlug;
  readonly getProductsBySkus: GetProductsBySkus;
  readonly listProducts: ListProducts;
  readonly saveProduct: SaveProduct;
  readonly importProducts: ImportProducts;
  readonly searchProducts: SearchProducts;
  readonly getCollection: GetCollection;
  readonly listCollections: ListCollections;
  readonly getCollectionProducts: GetCollectionProducts;
  readonly saveCollection: SaveCollection;
  readonly bulkEdit: BulkEdit;
  readonly ensureIndexes: () => Promise<void>;
};

export const createCatalogModule = (deps: {
  db: Db;
  storeId: string;
  now: () => Date;
  nextId: () => EntityId<'Product'>;
  /**
   * Where the spreadsheet's stock column goes.
   *
   * Injected rather than imported: stock is a separate module, and the
   * composition root is the only place that knows both exist.
   */
  stock: StockWriter;
  /**
   * Where a supplier's image URL goes to be copied.
   *
   * Injected for the same reason as the stock writer: media is a separate
   * module, and only the composition root knows both exist.
   */
  images: ImageIngestor;
}): CatalogModule => {
  const repository = createMongoProductRepository(deps.db);
  const collections = createMongoCollectionRepository(deps.db);
  const wiring = { repository, storeId: deps.storeId };
  const collectionWiring = { repository: collections, storeId: deps.storeId };

  return {
    getProductBySlug: makeGetProductBySlug(wiring),
    getProductsBySkus: makeGetProductsBySkus(wiring),
    listProducts: makeListProducts(wiring),
    saveProduct: makeSaveProduct({ ...wiring, now: deps.now }),
    searchProducts: makeSearchProducts(wiring),
    getCollection: makeGetCollection(collectionWiring),
    listCollections: makeListCollections(collectionWiring),
    getCollectionProducts: makeGetCollectionProducts(wiring),
    saveCollection: makeSaveCollection({
      repository: collections,
      products: repository,
      storeId: deps.storeId,
    }),
    bulkEdit: makeBulkEdit({ ...wiring, now: deps.now }),
    importProducts: makeImportProducts({
      ...wiring,
      reader: createXlsxWorkbookReader(),
      stock: deps.stock,
      images: deps.images,
      now: deps.now,
      nextId: deps.nextId,
    }),
    ensureIndexes: async () => {
      await ensureProductIndexes(deps.db);
      await ensureCollectionIndexes(deps.db);
    },
  };
};
