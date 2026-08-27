/**
 * Public surface of the orders module.
 *
 * An order is the record of a transaction, so almost everything here is about
 * making sure it cannot be wrong: totals are checked rather than trusted, the
 * number comes from an atomic counter, and a double-tapped checkout is refused
 * by a unique index rather than by a check that could be raced.
 */

import type { EntityId } from '@platform/ids';
import type { Db } from '@platform/mongo';
import { makePlaceOrder, type PlaceOrder, type PlaceOrderDeps } from './application/place-order';
import {
  createMongoOrderRepository,
  ensureOrderIndexes,
} from './infrastructure/mongo-order-repository';

export type {
  PlaceOrder,
  PlaceOrderDeps,
  PlaceOrderError,
  PlaceOrderInput,
} from './application/place-order';
export type { ListOrdersQuery, OrderConflict, OrderPage, OrderRepository } from './contracts';
export type {
  Customer,
  DeliveryAddress,
  Order,
  OrderError,
  OrderId,
  OrderLine,
  OrderStatus,
  Region,
} from './domain/order';
export {
  canTransition,
  createOrder,
  holdsStock,
  isRegion,
  ORDER_STATUSES,
  REGIONS,
  totalItems,
} from './domain/order';

export type OrdersModule = {
  readonly placeOrder: PlaceOrder;
  readonly findByNumber: (number: string) => Promise<import('./domain/order').Order | null>;
  /**
   * What delivery will cost on this order.
   *
   * Exposed so the checkout page can show the same number the order will be
   * written with — quoting a total the order then disagrees with is the failure
   * this whole module is careful about.
   */
  readonly deliveryFeeCents: () => Promise<number>;
  readonly ensureIndexes: () => Promise<void>;
};

export const createOrdersModule = (
  deps: Omit<PlaceOrderDeps, 'repository'> & { db: Db; nextId: () => EntityId<'Order'> },
): OrdersModule => {
  const repository = createMongoOrderRepository(deps.db);

  return {
    placeOrder: makePlaceOrder({ ...deps, repository }),
    findByNumber: (number) => repository.findByNumber(deps.storeId, number),
    deliveryFeeCents: deps.deliveryFeeCents,
    ensureIndexes: () => ensureOrderIndexes(deps.db),
  };
};
