/**
 * Public surface of the cart module.
 *
 * The cart has a domain and an application layer and no infrastructure, because
 * it has nothing to store: it IS a cookie. The reasoning is at the top of
 * domain/cart.ts.
 */

import { makePriceCart, type PriceCart, type PriceCartDeps } from './application/price-cart';

export type {
  LineProblem,
  PriceCart,
  PriceCartDeps,
  PricedCart,
  PricedLine,
} from './application/price-cart';
export type { Cart, CartError, CartLine } from './domain/cart';
export {
  addToCart,
  EMPTY_CART,
  formatCart,
  isEmpty,
  keepOnly,
  MAX_LINES,
  MAX_QUANTITY,
  parseCart,
  quantityOf,
  removeFromCart,
  setQuantity,
  totalItems,
} from './domain/cart';

export type CartModule = {
  readonly priceCart: PriceCart;
};

export const createCartModule = (deps: PriceCartDeps): CartModule => ({
  priceCart: makePriceCart(deps),
});
