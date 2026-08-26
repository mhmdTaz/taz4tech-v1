/**
 * Public surface of the catalogue module.
 *
 * Everything the rest of the system may know about the catalogue is on this
 * page. The boundary check rejects any import that reaches past it, which is
 * what leaves the folders behind it free to change.
 */

import type { Db } from '@platform/mongo';
import { type GetProductBySlug, makeGetProductBySlug } from './application/get-product-by-slug';
import { type ListProducts, makeListProducts } from './application/list-products';
import {
  createMongoProductRepository,
  ensureProductIndexes,
} from './infrastructure/mongo-product-repository';

export type { GetProductBySlug, GetProductBySlugError } from './application/get-product-by-slug';
export type {
  ListProducts,
  ListProductsError,
  ListProductsInput,
} from './application/list-products';
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './application/list-products';
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
  readonly ensureIndexes: () => Promise<void>;
};

export const createCatalogModule = (deps: { db: Db; storeId: string }): CatalogModule => {
  const repository = createMongoProductRepository(deps.db);
  const wiring = { repository, storeId: deps.storeId };

  return {
    getProductBySlug: makeGetProductBySlug(wiring),
    listProducts: makeListProducts(wiring),
    ensureIndexes: () => ensureProductIndexes(deps.db),
  };
};
