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
import type { Region } from '@platform/regions';
import { makePlaceOrder, type PlaceOrder, type PlaceOrderDeps } from './application/place-order';
import {
  type ListOrders,
  makeListOrders,
  makeUpdateOrderStatus,
  type UpdateOrderStatus,
} from './application/update-order-status';
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
export type {
  ListOrders,
  PhoneSearch,
  UpdateOrderStatus,
  UpdateOrderStatusError,
} from './application/update-order-status';
export { DEFAULT_ORDER_PAGE, MAX_ORDER_PAGE } from './application/update-order-status';
export type { WhatsAppLabels, WhatsAppOptions } from './application/whatsapp-message';
export {
  displayPhone,
  MAX_LISTED_LINES,
  whatsAppLink,
  whatsAppMessage,
} from './application/whatsapp-message';
export type {
  ListOrdersQuery,
  OrderConflict,
  OrderPage,
  OrderRepository,
  StockLedger,
  StockTakeFailure,
} from './contracts';
export type {
  Customer,
  DeliveryAddress,
  Order,
  OrderError,
  OrderId,
  OrderLine,
  OrderStatus,
} from './domain/order';
export {
  canTransition,
  createOrder,
  holdsStock,
  ORDER_STATUSES,
  totalItems,
} from './domain/order';

export type OrdersModule = {
  readonly placeOrder: PlaceOrder;
  readonly listOrders: ListOrders;
  readonly updateStatus: UpdateOrderStatus;
  readonly findById: (id: string) => Promise<import('./domain/order').Order | null>;
  readonly findByNumber: (number: string) => Promise<import('./domain/order').Order | null>;
  /**
   * What delivery will cost to one governorate.
   *
   * Exposed so the checkout page can show the same number the order will be
   * written with — quoting a total the order then disagrees with is the failure
   * this whole module is careful about. It takes the region because that is the
   * only thing the price depends on, and the page knows it before the order does.
   */
  readonly deliveryFeeCents: (region: Region) => Promise<number>;
  readonly ensureIndexes: () => Promise<void>;
};

export const createOrdersModule = (
  deps: Omit<PlaceOrderDeps, 'repository'> & { db: Db; nextId: () => EntityId<'Order'> },
): OrdersModule => {
  const repository = createMongoOrderRepository(deps.db);

  return {
    placeOrder: makePlaceOrder({ ...deps, repository }),
    listOrders: makeListOrders({ repository, storeId: deps.storeId }),
    updateStatus: makeUpdateOrderStatus({
      repository,
      stock: deps.stock,
      storeId: deps.storeId,
      now: deps.now,
    }),
    findById: (id) => repository.findById(deps.storeId, id),
    findByNumber: (number) => repository.findByNumber(deps.storeId, number),
    deliveryFeeCents: deps.deliveryFeeCents,
    ensureIndexes: () => ensureOrderIndexes(deps.db),
  };
};
