import { englishOnly } from '@platform/locale';
import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { describe, expect, it, vi } from 'vitest';
import type { ProductRepository } from '../contracts';
import type { Product } from '../domain/product';
import { makeSaveProduct } from './save-product';

const NOW = new Date('2026-08-27T10:00:00Z');
const usd = (cents: number) => unwrapOrThrow(fromCents(cents));

const product = (overrides: Partial<Product> = {}): Product => ({
  storeId: 'taz4tech',
  id: 'PRODUCT0000000000000000AA',
  slug: 'lenovo-ideapad-3',
  title: englishOnly('Lenovo IdeaPad 3'),
  description: englishOnly('A laptop.'),
  brand: 'Lenovo',
  status: 'active',
  optionNames: [],
  variants: [
    {
      sku: 'SKU-1',
      options: [],
      price: usd(129900),
      compareAtPrice: null,
      offerEndsAt: null,
      barcode: null,
      weightGrams: null,
    },
  ],
  media: [],
  specs: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const repositoryWith = (existing: Product | null = null) => {
  const repo: ProductRepository = {
    findBySlug: vi.fn().mockResolvedValue(existing),
    findById: vi.fn(),
    findBySku: vi.fn(),
    findBySlugs: vi.fn().mockResolvedValue([]),
    findBySkus: vi.fn().mockResolvedValue([]),
    findByIds: vi.fn().mockResolvedValue([]),
    search: vi.fn(),
    list: vi.fn(),
    save: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
  return repo;
};

const save = (repo: ProductRepository) =>
  makeSaveProduct({ repository: repo, storeId: 'taz4tech', now: () => NOW });

describe('saveProduct', () => {
  it('validates and stores a well-formed product', async () => {
    const repo = repositoryWith();
    const result = await save(repo)(product());

    expect(result.ok).toBe(true);
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('normalises before saving, so the stored value is the validated one', async () => {
    const repo = repositoryWith();
    await save(repo)(product({ brand: '  Lenovo  ' }));
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ brand: 'Lenovo' }));
  });

  it('refuses to write another tenant’s product, before doing anything else', async () => {
    const repo = repositoryWith();
    const result = await save(repo)(product({ storeId: 'someone-else', slug: 'not a slug' }));

    expect(result.ok).toBe(false);
    // Tenant is checked first: a cross-tenant write must never be reported as
    // merely invalid, or the real problem gets fixed instead of noticed.
    if (!result.ok) expect(result.error.tag).toBe('wrong_tenant');
    expect(repo.findBySlug).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rejects input the domain considers invalid, without touching the database', async () => {
    const repo = repositoryWith();
    const result = await save(repo)(product({ slug: 'Not A Slug' }));

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.tag === 'invalid') {
      expect(result.error.reason.tag).toBe('slug_invalid');
    }
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('reports a slug already used by a different product', async () => {
    // The unique index guarantees the constraint; this turns the driver's
    // "E11000 duplicate key" into an error naming the slug, which is what an
    // importer has to show against a spreadsheet row.
    const repo = repositoryWith(product({ id: 'PRODUCT0000000000000000BB' }));
    const result = await save(repo)(product());

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.tag === 'slug_taken') {
      expect(result.error.slug).toBe('lenovo-ideapad-3');
    }
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('allows a product to keep its own slug when updated', async () => {
    const repo = repositoryWith(product());
    const result = await save(repo)(product({ title: englishOnly('Renamed') }));

    expect(result.ok).toBe(true);
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('clears an expired offer against the injected clock, and still saves', async () => {
    /*
     * The clock is injected so this is testable without waiting. The behaviour
     * changed in Phase 3.6: an offer whose date has passed is cleared rather
     * than refused, because refusing it made a product unwritable a month after
     * its own promotion ended.
     */
    const repo = repositoryWith();
    const past = new Date('2026-01-01T00:00:00Z');
    const result = await save(repo)(
      product({
        variants: [
          {
            sku: 'SKU-1',
            options: [],
            price: usd(99900),
            compareAtPrice: usd(129900),
            offerEndsAt: past,
            barcode: null,
            weightGrams: null,
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.variants[0]?.compareAtPrice).toBeNull();
      expect(result.value.variants[0]?.offerEndsAt).toBeNull();
    }
  });

  it('lets a repository failure propagate', async () => {
    const repo: ProductRepository = {
      findBySlug: vi.fn().mockResolvedValue(null),
      findById: vi.fn(),
      findBySku: vi.fn(),
      findBySlugs: vi.fn().mockResolvedValue([]),
      findBySkus: vi.fn().mockResolvedValue([]),
      findByIds: vi.fn().mockResolvedValue([]),
      search: vi.fn(),
      list: vi.fn(),
      save: vi.fn().mockRejectedValue(new Error('write concern timeout')),
    };
    await expect(save(repo)(product())).rejects.toThrow('write concern timeout');
  });
});

describe('when the database refuses the write', () => {
  /*
   * save() reports a uniqueness conflict rather than throwing. That answer must
   * be propagated — ignoring it would turn a refused write into a reported
   * success, and the caller would go on to tell someone the product was saved.
   */
  const repositoryRefusing = (
    error: { tag: 'sku_taken'; sku: string } | { tag: 'slug_taken'; slug: string },
  ): ProductRepository => ({
    findBySlug: vi.fn().mockResolvedValue(null),
    findById: vi.fn(),
    findBySku: vi.fn(),
    findBySlugs: vi.fn().mockResolvedValue([]),
    findBySkus: vi.fn().mockResolvedValue([]),
    findByIds: vi.fn().mockResolvedValue([]),
    search: vi.fn(),
    list: vi.fn(),
    save: vi.fn().mockResolvedValue({ ok: false, error }),
  });

  it('reports a SKU already owned by another product', async () => {
    const result = await save(repositoryRefusing({ tag: 'sku_taken', sku: 'SKU-1' }))(product());
    expect(result).toEqual({ ok: false, error: { tag: 'sku_taken', sku: 'SKU-1' } });
  });

  it('reports a slug taken between the check and the write', async () => {
    // findBySlug says the slug is free; by the time the write lands it is not.
    // The pre-check is an optimisation for a good message, never the guarantee.
    const result = await save(repositoryRefusing({ tag: 'slug_taken', slug: 'taken' }))(product());
    expect(result).toEqual({ ok: false, error: { tag: 'slug_taken', slug: 'taken' } });
  });
});
