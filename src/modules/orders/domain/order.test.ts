import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { describe, expect, it } from 'vitest';
import {
  canTransition,
  createOrder,
  holdsStock,
  isRegion,
  MAX_CITY,
  MAX_LINES,
  MAX_NAME,
  MAX_NOTES,
  MAX_STREET,
  ORDER_STATUSES,
  type Order,
  type OrderLine,
  type OrderStatus,
  totalItems,
} from './order';

const NOW = new Date('2026-08-27T10:00:00Z');
const usd = (cents: number) => unwrapOrThrow(fromCents(cents));

const line = (overrides: Partial<OrderLine> = {}): OrderLine => {
  const quantity = overrides.quantity ?? 2;
  const unitPrice = overrides.unitPrice ?? usd(1999);
  return {
    sku: 'SKU-1',
    title: 'Anker Cable',
    options: [],
    quantity,
    unitPrice,
    lineTotal: usd(unitPrice.cents * quantity),
    ...overrides,
  };
};

const order = (overrides: Partial<Order> = {}): Order => {
  const lines = overrides.lines ?? [line()];
  const subtotal = usd(lines.reduce((total, each) => total + each.lineTotal.cents, 0));
  const deliveryFee = overrides.deliveryFee ?? usd(300);

  return {
    storeId: 'taz4tech',
    id: 'ORDER00000000000000001AA',
    number: 'T4T-26-000001',
    status: 'pending',
    customer: { name: 'Rana K', phone: '+9613123456' },
    locale: 'en',
    delivery: { region: 'beirut', city: 'Beirut', street: 'Hamra St, Bldg 4', notes: null },
    lines,
    subtotal,
    deliveryFee,
    total: usd(subtotal.cents + deliveryFee.cents),
    idempotencyKey: 'abc123',
    placedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
};

const created = (overrides: Partial<Order> = {}): Order => {
  const result = createOrder(order(overrides));
  if (!result.ok) throw new Error(`expected an order, got ${result.error.tag}`);
  return result.value;
};

describe('createOrder', () => {
  it('accepts a complete order', () => {
    expect(created().number).toBe('T4T-26-000001');
  });

  it('trims the customer name and the address', () => {
    const result = created({
      customer: { name: '  Rana K  ', phone: '+9613123456' },
      delivery: { region: 'beirut', city: ' Beirut ', street: ' Hamra ', notes: null },
    });

    expect(result.customer.name).toBe('Rana K');
    expect(result.delivery.city).toBe('Beirut');
    expect(result.delivery.street).toBe('Hamra');
  });

  it('treats a whitespace note as no note', () => {
    // A whitespace note reads as present to anything that only checks for null,
    // and prints as an empty line on a picking slip.
    const result = created({
      delivery: { region: 'beirut', city: 'Beirut', street: 'Hamra', notes: '   ' },
    });
    expect(result.delivery.notes).toBeNull();
  });

  it('keeps a real note', () => {
    const result = created({
      delivery: { region: 'beirut', city: 'Beirut', street: 'Hamra', notes: ' ring twice ' },
    });
    expect(result.delivery.notes).toBe('ring twice');
  });

  describe('the customer', () => {
    it('refuses an empty name', () => {
      expect(createOrder(order({ customer: { name: '  ', phone: '+9613123456' } }))).toEqual({
        ok: false,
        error: { tag: 'customer_name_empty' },
      });
    });

    it('refuses an absurdly long name', () => {
      const long = 'x'.repeat(MAX_NAME + 1);
      expect(createOrder(order({ customer: { name: long, phone: '+9613123456' } })).ok).toBe(false);
    });

    it('refuses a phone that is not already normalised', () => {
      // Catches a caller that skipped the parser, not a customer who typed it
      // oddly — by here it should already be E.164.
      expect(createOrder(order({ customer: { name: 'Rana', phone: '03123456' } }))).toEqual({
        ok: false,
        error: { tag: 'phone_not_e164', phone: '03123456' },
      });
    });
  });

  describe('the address', () => {
    it('refuses an empty city', () => {
      expect(
        createOrder(
          order({ delivery: { region: 'beirut', city: ' ', street: 'Hamra', notes: null } }),
        ).ok,
      ).toBe(false);
    });

    it('refuses an empty street, which is what gets a driver to the door', () => {
      expect(
        createOrder(
          order({ delivery: { region: 'beirut', city: 'Beirut', street: '', notes: null } }),
        ).ok,
      ).toBe(false);
    });

    it.each([
      ['city', 'MAX_CITY'],
      ['street', 'MAX_STREET'],
    ])('refuses an over-long %s', (field) => {
      // Bounded because these are printed on a picking slip and read out to a
      // driver; a field the length of a paragraph is a paste, not an address.
      const long = 'x'.repeat(500);
      const delivery = {
        region: 'beirut' as const,
        city: field === 'city' ? long : 'Beirut',
        street: field === 'street' ? long : 'Hamra',
        notes: null,
      };
      expect(createOrder(order({ delivery }))).toEqual({
        ok: false,
        error: { tag: 'field_too_long', field, max: field === 'city' ? MAX_CITY : MAX_STREET },
      });
    });

    it('refuses a note longer than a note', () => {
      const long = 'x'.repeat(MAX_NOTES + 1);
      expect(
        createOrder(
          order({ delivery: { region: 'beirut', city: 'Beirut', street: 'H', notes: long } }),
        ),
      ).toEqual({ ok: false, error: { tag: 'field_too_long', field: 'notes', max: MAX_NOTES } });
    });
  });

  describe('the lines', () => {
    it('refuses an order with no lines', () => {
      expect(createOrder(order({ lines: [] }))).toEqual({ ok: false, error: { tag: 'no_lines' } });
    });

    it('refuses more lines than a cart can hold', () => {
      const many = Array.from({ length: MAX_LINES + 1 }, (_, i) => line({ sku: `S-${i}` }));
      expect(createOrder(order({ lines: many }))).toEqual({
        ok: false,
        error: { tag: 'too_many_lines', max: MAX_LINES },
      });
    });

    it.each([0, -1, 1.5])('refuses a quantity of %s', (quantity) => {
      const bad = { ...line(), quantity, lineTotal: usd(0) };
      expect(createOrder(order({ lines: [bad] })).ok).toBe(false);
    });

    it('refuses a negative price', () => {
      const bad = line({ unitPrice: usd(-100), quantity: 1, lineTotal: usd(-100) });
      expect(createOrder(order({ lines: [bad] }))).toEqual({
        ok: false,
        error: { tag: 'price_negative', sku: 'SKU-1' },
      });
    });

    it('CHECKS the line arithmetic rather than trusting it', () => {
      /*
       * The one error in an order nobody notices until the cash is counted — and
       * by then the customer is at the door holding a different number.
       */
      const bad = { ...line({ unitPrice: usd(1999), quantity: 2 }), lineTotal: usd(3000) };
      expect(createOrder(order({ lines: [bad] }))).toEqual({
        ok: false,
        error: { tag: 'line_total_wrong', sku: 'SKU-1' },
      });
    });

    it('accepts a free line, which is a real thing a shop does', () => {
      const free = line({ unitPrice: usd(0), quantity: 1 });
      expect(createOrder(order({ lines: [free] })).ok).toBe(true);
    });
  });

  describe('the totals', () => {
    it('refuses a subtotal that does not match the lines', () => {
      expect(createOrder(order({ subtotal: usd(1) })).ok).toBe(false);
    });

    it('refuses a total that is not subtotal plus delivery', () => {
      expect(createOrder(order({ total: usd(1) })).ok).toBe(false);
    });

    it('accepts a zero delivery fee', () => {
      expect(created({ deliveryFee: usd(0) }).total.cents).toBe(3998);
    });

    it('refuses a negative delivery fee', () => {
      expect(createOrder(order({ deliveryFee: usd(-100) })).ok).toBe(false);
    });

    it('adds delivery on top of the lines', () => {
      const result = created({ deliveryFee: usd(500) });
      expect(result.subtotal.cents).toBe(3998);
      expect(result.total.cents).toBe(4498);
    });
  });

  it('refuses an order with no idempotency key', () => {
    // The unique index on it is what makes a double-tapped submit one order
    // rather than two, so an order without one cannot be protected.
    expect(createOrder(order({ idempotencyKey: '  ' }))).toEqual({
      ok: false,
      error: { tag: 'idempotency_key_empty' },
    });
  });

  it('keeps the line snapshot exactly as given', () => {
    // The whole point of an order. Change a price tomorrow and yesterday's order
    // must still say what was agreed.
    const snapshot = line({ title: 'Anker Cable (2m, Black)', unitPrice: usd(1999), quantity: 1 });
    const result = created({ lines: [snapshot] });

    expect(result.lines[0]).toEqual(snapshot);
  });
});

describe('the lifecycle', () => {
  it.each([
    ['pending', 'confirmed', true],
    ['pending', 'cancelled', true],
    ['confirmed', 'delivered', true],
    ['confirmed', 'cancelled', true],
    ['pending', 'delivered', false],
    ['delivered', 'cancelled', false],
    ['cancelled', 'pending', false],
    ['cancelled', 'confirmed', false],
    ['delivered', 'pending', false],
  ])('%s -> %s is %s', (from, to, allowed) => {
    expect(canTransition(from as OrderStatus, to as OrderStatus)).toBe(allowed);
  });

  it('never allows leaving a terminal state', () => {
    // Cancelling gives stock back, so reaching it twice would credit the shelf
    // twice — and there is no way back from delivered at all.
    for (const to of ORDER_STATUSES) {
      expect(canTransition('cancelled', to)).toBe(false);
      expect(canTransition('delivered', to)).toBe(false);
    }
  });

  it.each([
    ['pending', true],
    ['confirmed', true],
    ['delivered', true],
    ['cancelled', false],
  ])('an order that is %s holds stock: %s', (status, expected) => {
    expect(holdsStock(created({ status: status as OrderStatus }))).toBe(expected);
  });
});

describe('reading an order', () => {
  it('counts items, not lines', () => {
    const result = created({
      lines: [line({ sku: 'A', quantity: 2 }), line({ sku: 'B', quantity: 3 })],
    });
    expect(totalItems(result)).toBe(5);
  });
});

describe('isRegion', () => {
  it("accepts each of Lebanon's governorates", () => {
    expect(isRegion('beirut')).toBe(true);
    expect(isRegion('baalbek_hermel')).toBe(true);
  });

  it('refuses anything else', () => {
    // A closed list rather than free text: "Mount Lebanon" typed four ways is
    // four regions to anyone counting deliveries.
    expect(isRegion('Mount Lebanon')).toBe(false);
    expect(isRegion('')).toBe(false);
  });
});
