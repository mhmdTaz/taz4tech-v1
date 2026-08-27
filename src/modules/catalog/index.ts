/**
 * Public surface of the catalogue module.
 *
 * Everything the rest of the system may know about the catalogue is on this
 * page. The boundary check rejects any import that reaches past it, which is
 * what leaves the folders behind it free to change.
 */

import type { EntityId } from '@platform/ids';
import type { Db } from '@platform/mongo';
import { type GetProductBySlug, makeGetProductBySlug } from './application/get-product-by-slug';
import { type ImportProducts, makeImportProducts } from './application/import-products';
import { type ListProducts, makeListProducts } from './application/list-products';
import { makeSaveProduct, type SaveProduct } from './application/save-product';
import {
  createMongoProductRepository,
  ensureProductIndexes,
} from './infrastructure/mongo-product-repository';
import { createXlsxWorkbookReader } from './infrastructure/xlsx-workbook-reader';

export type { GetProductBySlug, GetProductBySlugError } from './application/get-product-by-slug';
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
export type { SaveProduct, SaveProductError } from './application/save-product';
export type { ListProductsQuery, ProductPage, ProductRepository } from './contracts';
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

export type CatalogModule = {
  readonly getProductBySlug: GetProductBySlug;
  readonly listProducts: ListProducts;
  readonly saveProduct: SaveProduct;
  readonly importProducts: ImportProducts;
  readonly ensureIndexes: () => Promise<void>;
};

export const createCatalogModule = (deps: {
  db: Db;
  storeId: string;
  now: () => Date;
  nextId: () => EntityId<'Product'>;
}): CatalogModule => {
  const repository = createMongoProductRepository(deps.db);
  const wiring = { repository, storeId: deps.storeId };

  return {
    getProductBySlug: makeGetProductBySlug(wiring),
    listProducts: makeListProducts(wiring),
    saveProduct: makeSaveProduct({ ...wiring, now: deps.now }),
    importProducts: makeImportProducts({
      ...wiring,
      reader: createXlsxWorkbookReader(),
      now: deps.now,
      nextId: deps.nextId,
    }),
    ensureIndexes: () => ensureProductIndexes(deps.db),
  };
};
