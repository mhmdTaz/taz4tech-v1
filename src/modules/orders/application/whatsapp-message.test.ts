import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { describe, expect, it } from 'vitest';
import type { Order, OrderLine } from '../domain/order';
import {
  displayPhone,
  MAX_LISTED_LINES,
  type WhatsAppOptions,
  whatsAppLink,
  whatsAppMessage,
} from './whatsapp-message';

const NOW = new Date('2026-08-27T10:00:00Z');
const usd = (cents: number) => unwrapOrThrow(fromCents(cents));

const line = (overrides: Partial<OrderLine> = {}): OrderLine => ({
  sku: 'SKU-1',
  title: 'Anker Cable',
  options: [],
  quantity: 2,
  unitPrice: usd(1999),
  lineTotal: usd(3998),
  ...overrides,
});

const order = (overrides: Partial<Order> = {}): Order => ({
  storeId: 'taz4tech',
  id: 'ORDER1',
  number: 'T4T-26-000042',
  status: 'pending',
  customer: { name: 'Rana K', phone: '+9613123456' },
  locale: 'en',
  delivery: { region: 'beirut', city: 'Beirut', street: 'Hamra St', notes: null },
  lines: [line()],
  subtotal: usd(3998),
  deliveryFee: usd(0),
  total: usd(3998),
  viewToken: 'TESTTOKEN0000000000000001',
  idempotencyKey: 'k',
  placedAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const options: WhatsAppOptions = {
  labels: {
    greeting: 'Hello {name},',
    intro: 'This is Taz4Tech about your order {number}.',
    itemsHeading: 'Your order:',
    totalLabel: 'Total',
    deliveryLabel: 'Delivering to',
    codNote: 'You pay the driver in cash on delivery.',
    closing: 'Thank you!',
  },
  formatMoney: (cents) => `$${(cents / 100).toFixed(2)}`,
  regionLabel: 'Beirut',
};

describe('whatsAppMessage', () => {
  it('greets the customer by name and names the order', async () => {
    const message = whatsAppMessage(order(), options);

    expect(message).toContain('Hello Rana K,');
    expect(message).toContain('T4T-26-000042');
  });

  it('separates its sections with blank lines', () => {
    // The message is written as sections with '' between them. Sent as one
    // unbroken block it reads as a wall of text on a phone.
    const message = whatsAppMessage(order(), options);
    expect(message).toContain('\n\n');
  });

  it('lists each line with its quantity and total', () => {
    const message = whatsAppMessage(order(), options);
    expect(message).toContain('• 2 × Anker Cable — $39.98');
  });

  it('names the variant, which is how a picking mistake gets caught', () => {
    // "Anker Cable" is not enough for the customer to confirm; "Black, 2m" is.
    const message = whatsAppMessage(
      order({
        lines: [
          line({
            options: [
              { name: 'Colour', value: 'Black' },
              { name: 'Length', value: '2m' },
            ],
          }),
        ],
      }),
      options,
    );

    expect(message).toContain('Anker Cable (Black, 2m)');
  });

  it('states the total and the address', () => {
    const message = whatsAppMessage(order(), options);

    expect(message).toContain('Total: $39.98');
    expect(message).toContain('Delivering to: Hamra St, Beirut, Beirut');
  });

  it('says how payment works', () => {
    // The message a customer keeps. It should answer "what do I owe and how do
    // I pay" without them having to ask.
    expect(whatsAppMessage(order(), options)).toContain('cash on delivery');
  });

  it('SUMMARISES a long order rather than truncating it silently', () => {
    /*
     * A URL is not an unlimited channel. Cutting the list off without saying so
     * would send a customer a confirmation missing items they ordered — which is
     * exactly the message they would then trust.
     */
    const many = Array.from({ length: MAX_LISTED_LINES + 4 }, (_, i) => line({ sku: `S-${i}` }));
    const message = whatsAppMessage(order({ lines: many }), options);

    expect(message).toContain('• +4');
    expect(message.split('•')).toHaveLength(MAX_LISTED_LINES + 2);
  });

  it('adds no summary line when everything fits', () => {
    expect(whatsAppMessage(order(), options)).not.toContain('+0');
  });

  it('leaves no blank line where an empty label was', () => {
    // Every label is supplied, but a caller that leaves one empty should get a
    // tidy message rather than a gap in the middle of it.
    const message = whatsAppMessage(order(), {
      ...options,
      labels: { ...options.labels, closing: '' },
    });

    expect(message.endsWith('\n')).toBe(false);
    expect(message).not.toContain('\n\n\n');
  });
});

describe('whatsAppLink', () => {
  it('addresses the customer, with no plus', () => {
    // wa.me wants digits only; a plus opens a chat with nobody.
    expect(whatsAppLink(order(), options)).toContain('https://wa.me/9613123456?');
  });

  it('carries the message url-encoded', () => {
    const link = whatsAppLink(order(), options);
    expect(link).toContain(encodeURIComponent('Hello Rana K,'));
  });

  it('encodes a message containing characters that would break a query string', () => {
    const link = whatsAppLink(
      order({ delivery: { region: 'beirut', city: 'Beirut', street: 'A&B #3', notes: null } }),
      options,
    );

    expect(link).not.toContain('&B');
    expect(link).toContain('%26B');
  });

  it('survives a round trip back to the original text', () => {
    const link = whatsAppLink(order(), options);
    const text = new URL(link).searchParams.get('text');

    expect(text).toBe(whatsAppMessage(order(), options));
  });
});

describe('displayPhone', () => {
  it('groups the number for reading aloud and dialling', () => {
    expect(displayPhone(order())).toBe('+961 3 123 456');
  });
});
