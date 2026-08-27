import type { OrderStatus } from '@modules/orders';

/**
 * An order's status, coloured — but never coloured ALONE.
 *
 * The word is always present. Colour on its own fails for a colour-blind reader
 * and disappears entirely in a printed picking slip, and "is this one cancelled"
 * is not a question to answer by hue.
 */
const TONES: Record<OrderStatus, string> = {
  pending: 'bg-caution/15 text-caution',
  confirmed: 'bg-accent/15 text-accent',
  delivered: 'bg-positive/15 text-positive',
  cancelled: 'bg-hairline text-muted line-through',
};

export const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export const StatusChip = ({ status }: { status: OrderStatus }) => (
  <span className={`rounded px-2 py-0.5 text-xs font-medium ${TONES[status]}`}>
    {STATUS_LABELS[status]}
  </span>
);
