/**
 * The WhatsApp message the operator sends about an order.
 *
 * TAP TO SEND, NOT SEND
 * ---------------------
 * This produces a `wa.me` link that opens WhatsApp with the message already
 * written. A person presses send. Nothing is delivered automatically and no
 * business API is involved — that is Phase 4, on a second number, and it needs
 * template approval and a different set of promises to Meta.
 *
 * The distinction is not a technicality. A link the operator taps is a message
 * from a person, sent from their own number, that a customer can reply to. An
 * automated send is a broadcast, and the rules around those are stricter for
 * good reasons.
 *
 * WRITTEN IN THE CUSTOMER'S LANGUAGE
 * ----------------------------------
 * The order records the locale it was placed in, so the confirmation goes back
 * in the language the customer shopped in. Every string arrives as a parameter:
 * this layer composes, the delivery layer translates.
 */

import { formatForDisplay, toWhatsAppNumber } from '@platform/phone';
import type { Order } from '../domain/order';

export type WhatsAppLabels = {
  /** "Hello {name}," */
  readonly greeting: string;
  /** "This is Taz4Tech about your order {number}." */
  readonly intro: string;
  readonly itemsHeading: string;
  readonly totalLabel: string;
  readonly deliveryLabel: string;
  /** "You pay the driver in cash on delivery." */
  readonly codNote: string;
  readonly closing: string;
};

export type WhatsAppOptions = {
  readonly labels: WhatsAppLabels;
  /** Already formatted for the customer's locale. */
  readonly formatMoney: (cents: number) => string;
  readonly regionLabel: string;
};

/**
 * A cap, because a URL is not an unlimited channel.
 *
 * Long orders are listed up to this many lines and then summarised. Silently
 * truncating would send a customer a confirmation missing items they ordered,
 * which is worse than a message that says how many more there are.
 */
export const MAX_LISTED_LINES = 12;

const line = (parts: readonly string[]): string =>
  parts.filter((part) => part.length > 0).join('\n');

export const whatsAppMessage = (order: Order, options: WhatsAppOptions): string => {
  const { labels, formatMoney, regionLabel } = options;

  const listed = order.lines.slice(0, MAX_LISTED_LINES);
  const remaining = order.lines.length - listed.length;

  const items = listed.map((each) => {
    const variant = each.options.map((option) => option.value).join(', ');
    const name = variant.length > 0 ? `${each.title} (${variant})` : each.title;
    return `• ${each.quantity} × ${name} — ${formatMoney(each.lineTotal.cents)}`;
  });

  if (remaining > 0) items.push(`• +${remaining}`);

  return line([
    labels.greeting.replace('{name}', order.customer.name),
    labels.intro.replace('{number}', order.number),
    '',
    labels.itemsHeading,
    ...items,
    '',
    `${labels.totalLabel}: ${formatMoney(order.total.cents)}`,
    `${labels.deliveryLabel}: ${order.delivery.street}, ${order.delivery.city}, ${regionLabel}`,
    '',
    labels.codNote,
    labels.closing,
  ]);
};

/**
 * The link that opens WhatsApp with the message ready.
 *
 * `wa.me` rather than `api.whatsapp.com`: it is the documented short form and it
 * works on a phone, on desktop and in the web client without the operator
 * choosing which. The number is digits only, no plus — that is the shape wa.me
 * wants, and passing it with the plus opens a chat with nobody.
 */
export const whatsAppLink = (order: Order, options: WhatsAppOptions): string =>
  `https://wa.me/${toWhatsAppNumber(order.customer.phone)}?text=${encodeURIComponent(
    whatsAppMessage(order, options),
  )}`;

/** For the operator to read and dial. */
export const displayPhone = (order: Order): string => formatForDisplay(order.customer.phone);
