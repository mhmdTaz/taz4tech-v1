'use server';

import { ORDER_STATUSES, type OrderStatus } from '@modules/orders';
import { notFound, redirect } from 'next/navigation';
import { getContainer } from '@/composition';
import { requireAdmin } from '../session';

/**
 * Moving an order along.
 *
 * A plain form post per action, so each button is its own request with its own
 * fields — a single form with several submit buttons posts the same body for all
 * of them, and "cancel" carrying whatever "confirm" needed is a request nobody
 * made.
 *
 * The outcome comes back as a query parameter and the page re-reads the order.
 * That is not laziness: after a transition the ONLY trustworthy view of the
 * order is a fresh read, because the interesting failure is somebody else
 * having moved it in the meantime.
 */

const isStatus = (value: unknown): value is OrderStatus =>
  typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);

export const moveOrder = async (formData: FormData): Promise<void> => {
  await requireAdmin();

  const id = formData.get('id');
  const from = formData.get('from');
  const to = formData.get('to');
  const number = formData.get('number');

  if (typeof id !== 'string' || typeof number !== 'string') notFound();
  if (!isStatus(from) || !isStatus(to)) notFound();

  const container = await getContainer();
  // `from` is the status the screen was rendered from, carried through so a page
  // left open on a stale order is answered with what it is now rather than with
  // an accusation. The write filters on it, so forging it changes nothing.
  const result = await container.orders.updateStatus(id, from, to);

  const params = new URLSearchParams();

  if (result.ok) {
    container.logger.info('order status changed', { number: result.value.number, to });
    params.set('moved', to);
  } else if (result.error.tag === 'already_moved') {
    // Not the operator's mistake: the transition was legal when they looked at
    // the screen. Tell them what it is now and let them decide again.
    params.set('conflict', result.error.current);
  } else if (result.error.tag === 'not_found') {
    notFound();
  } else {
    params.set('conflict', 'not_allowed');
  }

  redirect(`/admin/orders/${encodeURIComponent(number)}?${params.toString()}`);
};
