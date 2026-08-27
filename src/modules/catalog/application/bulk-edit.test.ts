import type { EntityId } from '@platform/ids';
import { englishOnly } from '@platform/locale';
import { fromCents } from '@platform/money';
import { err, ok, unwrapOrThrow } from '@platform/result';
import { describe, expect, it, vi } from 'vitest';
import { fakeProductRepository } from '@/test-support/catalog';
import type { Product, ProductId, Variant } from '../domain/product';
import { MAX_BULK_SELECTION, makeBulkEdit, toBulkEditReport } from './bulk-edit';

const NOW = new Date('2026-08-27T10:00:00Z');
const EARLIER = new Date('2026-01-01T10:00:00Z');
const LATER = new Date('2026-12-31T10:00:00Z');

const usd = (cents: number) => unwrapOrThrow(fromCents(cents));
const id = (n: number): ProductId => `PRODUCT${String(n).padStart(19, '0')}` as EntityId<'Product'>;

const variant = (overrides: Partial<Variant> = {}): Variant => ({
  sku: 'SKU-1',
  options: [],
  price: usd(1999),
  compareAtPrice: null,
  offerEndsAt: null,
  barcode: null,
  weightGrams: null,
  ...overrides,
});

const product = (n: number, overrides: Partial<Product> = {}): Product => ({
  storeId: 'taz4tech',
  id: id(n),
  slug: `product-${n}`,
  title: englishOnly(`Product ${n}`),
  description: englishOnly('A thing.'),
  brand: 'Anker',
  status: 'active',
  optionNames: [],
  variants: [variant({ sku: `SKU-${n}` })],
  media: [],
  specs: [],
  createdAt: EARLIER,
  updatedAt: EARLIER,
  ...overrides,
});

const editor = (
  existing: Product[],
  overrides: Parameters<typeof fakeProductRepository>[0] = {},
) => {
  const saved: Product[] = [];
  const repository = fakeProductRepository({
    // Filters by storeId as well as by id, because the real one does. A fake
    // that ignored the tenant would make the isolation test below pass without
    // asserting anything — the use case would have been handed a product it
    // should never have seen, and reported it as a change.
    findByIds: vi.fn(async (storeId: string, ids: readonly ProductId[]) =>
      existing.filter((candidate) => candidate.storeId === storeId && ids.includes(candidate.id)),
    ),
    save: vi.fn(async (candidate: Product) => {
      saved.push(candidate);
      return ok(undefined);
    }),
    ...overrides,
  });

  return {
    repository,
    saved,
    run: makeBulkEdit({ repository, storeId: 'taz4tech', now: () => NOW }),
  };
};

describe('bulkEdit', () => {
  it('previews without writing anything by default', async () => {
    // The default has to be safe, for the same reason it is in the importer.
    const { run, saved } = editor([product(1)]);
    const result = await run({
      productIds: [id(1)],
      operation: { tag: 'set_status', status: 'draft' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.committed).toBe(false);
    expect(result.value.written).toBe(0);
    expect(result.value.changes).toHaveLength(1);
    expect(saved).toEqual([]);
  });

  it('writes only when commit is explicitly true', async () => {
    const { run, saved } = editor([product(1)]);
    const result = await run({
      productIds: [id(1)],
      operation: { tag: 'set_status', status: 'draft' },
      commit: true,
    });

    if (!result.ok) return;
    expect(result.value.written).toBe(1);
    expect(saved.map((p) => p.status)).toEqual(['draft']);
  });

  it('carries the before and the after, so the preview can show both', async () => {
    const { run } = editor([product(1)]);
    const result = await run({
      productIds: [id(1)],
      operation: { tag: 'scale_price', basisPoints: 10_500 },
    });

    if (!result.ok) return;
    expect(result.value.changes[0]?.before.variants[0]?.price.cents).toBe(1999);
    expect(result.value.changes[0]?.after.variants[0]?.price.cents).toBe(2099);
  });

  describe('the selection', () => {
    it('refuses an empty selection rather than reporting a successful no-op', async () => {
      const { run } = editor([]);
      expect(await run({ productIds: [], operation: { tag: 'clear_offer' } })).toEqual({
        ok: false,
        error: { tag: 'nothing_selected' },
      });
    });

    it('refuses more than the cap', async () => {
      const ids = Array.from({ length: MAX_BULK_SELECTION + 1 }, (_, i) => id(i + 1));
      const { run } = editor([]);

      expect(await run({ productIds: ids, operation: { tag: 'clear_offer' } })).toEqual({
        ok: false,
        error: {
          tag: 'too_many_selected',
          count: MAX_BULK_SELECTION + 1,
          limit: MAX_BULK_SELECTION,
        },
      });
    });

    it('deduplicates, so a repeated id is not counted twice', async () => {
      const { run, saved } = editor([product(1)]);
      const result = await run({
        productIds: [id(1), id(1), id(1)],
        operation: { tag: 'set_status', status: 'draft' },
        commit: true,
      });

      if (!result.ok) return;
      expect(result.value.written).toBe(1);
      expect(saved).toHaveLength(1);
    });

    it('counts duplicates once against the cap', async () => {
      // MAX+1 ids that are all the same product is a selection of one.
      const ids = Array.from({ length: MAX_BULK_SELECTION + 1 }, () => id(1));
      const { run } = editor([product(1)]);
      const result = await run({
        productIds: ids,
        operation: { tag: 'set_status', status: 'draft' },
      });
      expect(result.ok).toBe(true);
    });

    it('reports an id that matched nothing rather than ignoring it', async () => {
      // Silently acting on nine of the ten products the operator chose is the
      // failure mode this exists to prevent.
      const { run } = editor([product(1)]);
      const result = await run({
        productIds: [id(1), id(99)],
        operation: { tag: 'set_status', status: 'draft' },
      });

      if (!result.ok) return;
      expect(result.value.missing).toEqual([id(99)]);
      expect(result.value.changes).toHaveLength(1);
    });

    it('keeps the operator ordering, with missing ids in place', async () => {
      const { run } = editor([product(1), product(2)]);
      const result = await run({
        productIds: [id(2), id(99), id(1)],
        operation: { tag: 'set_status', status: 'draft' },
      });

      if (!result.ok) return;
      expect(result.value.changes.map((c) => c.before.slug)).toEqual(['product-2', 'product-1']);
    });

    it('never reaches into another tenant', async () => {
      // findByIds filters by store, so a foreign id simply is not found — and it
      // is reported as missing rather than passed over in silence.
      const { run } = editor([product(1, { storeId: 'tenant-b' })]);
      const result = await run({
        productIds: [id(1)],
        operation: { tag: 'set_status', status: 'draft' },
      });

      if (!result.ok) return;
      expect(result.value.changes).toEqual([]);
      expect(result.value.missing).toEqual([id(1)]);
    });
  });

  describe('the operation itself', () => {
    it('refuses a multiplier outside the sane range before touching a product', async () => {
      const { run, repository } = editor([product(1)]);
      const result = await run({
        productIds: [id(1)],
        operation: { tag: 'scale_price', basisPoints: 10_000_000 },
        commit: true,
      });

      expect(result).toEqual({
        ok: false,
        error: { tag: 'invalid_basis_points', value: 10_000_000 },
      });
      // Nothing was even read: a typo must not cost a database round trip, and
      // must certainly not partially apply.
      expect(repository.findByIds).not.toHaveBeenCalled();
    });

    it('refuses a fractional multiplier', async () => {
      const { run } = editor([product(1)]);
      const result = await run({
        productIds: [id(1)],
        operation: { tag: 'scale_price', basisPoints: 10_500.5 },
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('sorting products by outcome', () => {
    it('separates changed, unchanged and refused', async () => {
      const expired = product(3, {
        variants: [variant({ sku: 'SKU-3', compareAtPrice: usd(2499), offerEndsAt: EARLIER })],
      });

      const { run } = editor([
        product(1, { status: 'active' }),
        product(2, { status: 'draft' }),
        expired,
      ]);

      const result = await run({
        productIds: [id(1), id(2), id(3)],
        operation: { tag: 'set_status', status: 'draft' },
      });

      if (!result.ok) return;
      expect(result.value.changes.map((c) => c.before.slug)).toEqual(['product-1']);
      expect(result.value.unchanged.map((p) => p.slug)).toEqual(['product-2']);
      expect(result.value.refusals.map((r) => r.product.slug)).toEqual(['product-3']);
    });

    it('writes the changed ones and leaves the rest alone', async () => {
      const { run, saved } = editor([
        product(1, { status: 'active' }),
        product(2, { status: 'draft' }),
      ]);

      const result = await run({
        productIds: [id(1), id(2)],
        operation: { tag: 'set_status', status: 'draft' },
        commit: true,
      });

      if (!result.ok) return;
      expect(result.value.written).toBe(1);
      // The already-draft product is not rewritten: that would move updatedAt
      // for nothing.
      expect(saved.map((p) => p.slug)).toEqual(['product-1']);
    });

    it('lets a refusal cost only its own product', async () => {
      const expired = product(2, {
        variants: [variant({ sku: 'SKU-2', compareAtPrice: usd(2499), offerEndsAt: EARLIER })],
      });
      const { run, saved } = editor([product(1), expired]);

      const result = await run({
        productIds: [id(1), id(2)],
        operation: { tag: 'set_status', status: 'draft' },
        commit: true,
      });

      if (!result.ok) return;
      expect(result.value.written).toBe(1);
      expect(result.value.refusals).toHaveLength(1);
      expect(saved.map((p) => p.slug)).toEqual(['product-1']);
    });
  });

  describe('a write that loses a race', () => {
    it('reports the failure and keeps going', async () => {
      const { run } = editor([product(1), product(2)], {
        save: vi.fn(async (candidate: Product) =>
          candidate.slug === 'product-1'
            ? err({ tag: 'sku_taken' as const, sku: 'SKU-1' })
            : ok(undefined),
        ),
      });

      const result = await run({
        productIds: [id(1), id(2)],
        operation: { tag: 'set_status', status: 'draft' },
        commit: true,
      });

      if (!result.ok) return;
      expect(result.value.written).toBe(1);
      expect(result.value.failures).toEqual([
        { slug: 'product-1', conflict: { tag: 'sku_taken', sku: 'SKU-1' } },
      ]);
    });

    it('still throws on something that is not a conflict', async () => {
      const { run } = editor([product(1)], {
        save: vi.fn().mockRejectedValue(new Error('connection reset')),
      });

      await expect(
        run({
          productIds: [id(1)],
          operation: { tag: 'set_status', status: 'draft' },
          commit: true,
        }),
      ).rejects.toThrow('connection reset');
    });
  });
});

describe('toBulkEditReport', () => {
  const reportFor = async (products: Product[], ids: ProductId[], commit = false) => {
    const { run } = editor(products);
    const result = await run({
      productIds: ids,
      operation: { tag: 'scale_price', basisPoints: 10_500 },
      ...(commit ? { commit: true } : {}),
    });
    if (!result.ok) throw new Error('expected a plan');
    return toBulkEditReport(result.value);
  };

  it('shows before and after as plain data', async () => {
    const report = await reportFor([product(1)], [id(1)]);

    expect(report.changes[0]?.before.priceFromCents).toBe(1999);
    expect(report.changes[0]?.after.priceFromCents).toBe(2099);
    expect(report.changes[0]?.after.title).toBe('Product 1');
  });

  it('spans the price range of a multi-variant product', async () => {
    const wide = product(1, {
      optionNames: ['Size'],
      variants: [
        variant({ sku: 'A', options: [{ name: 'Size', value: 'S' }], price: usd(1000) }),
        variant({ sku: 'B', options: [{ name: 'Size', value: 'L' }], price: usd(3000) }),
      ],
    });

    const report = await reportFor([wide], [id(1)]);
    expect(report.changes[0]?.before.priceFromCents).toBe(1000);
    expect(report.changes[0]?.before.priceToCents).toBe(3000);
  });

  it('counts the variants on offer, which is what makes clear_offer legible', async () => {
    const onOffer = product(1, {
      optionNames: ['Size'],
      variants: [
        variant({
          sku: 'A',
          options: [{ name: 'Size', value: 'S' }],
          compareAtPrice: usd(2499),
          offerEndsAt: LATER,
        }),
        variant({ sku: 'B', options: [{ name: 'Size', value: 'L' }] }),
      ],
    });

    const report = await reportFor([onOffer], [id(1)]);
    expect(report.changes[0]?.before.onOfferVariants).toBe(1);
  });

  it('renders a missing id as a plain string', async () => {
    const report = await reportFor([], [id(9)]);
    expect(report.missing).toEqual([id(9)]);
  });

  it('explains a conflict in words rather than as a tag', async () => {
    const { run } = editor([product(1)], {
      save: vi.fn(async () => err({ tag: 'sku_taken' as const, sku: 'SKU-1' })),
    });
    const result = await run({
      productIds: [id(1)],
      operation: { tag: 'set_status', status: 'draft' },
      commit: true,
    });
    if (!result.ok) throw new Error('expected a plan');

    expect(toBulkEditReport(result.value).failures).toEqual([
      { slug: 'product-1', reason: 'the SKU SKU-1 was taken while this edit was running' },
    ]);
  });

  it('explains a slug conflict too', async () => {
    const { run } = editor([product(1)], {
      save: vi.fn(async () => err({ tag: 'slug_taken' as const, slug: 'product-1' })),
    });
    const result = await run({
      productIds: [id(1)],
      operation: { tag: 'set_status', status: 'draft' },
      commit: true,
    });
    if (!result.ok) throw new Error('expected a plan');

    expect(toBulkEditReport(result.value).failures[0]?.reason).toContain('URL slug product-1');
  });

  it('carries refusals with the reason intact', async () => {
    const expired = product(1, {
      variants: [variant({ sku: 'SKU-1', compareAtPrice: usd(2499), offerEndsAt: EARLIER })],
    });
    const report = await reportFor([expired], [id(1)]);

    expect(report.refusals[0]?.product.slug).toBe('product-1');
    expect(report.refusals[0]?.reason).toMatchObject({
      tag: 'invalid_result',
      reason: { tag: 'offer_end_date_in_past' },
    });
  });

  it('produces something structuredClone can carry to the browser', async () => {
    // The reason this function exists: a Product holds Money and Date objects,
    // and any of them leaking here would either be rejected at the client
    // boundary or silently reshaped.
    const report = await reportFor([product(1), product(2)], [id(1), id(2)]);

    expect(() => structuredClone(report)).not.toThrow();
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
