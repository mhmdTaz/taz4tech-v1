import { fromCents } from '@platform/money';
import { unwrapOrThrow } from '@platform/result';
import { describe, expect, it, vi } from 'vitest';
import type { ImageIngestor } from '../../contracts';
import type { Media, Product } from '../../domain/product';
import { takeImages } from './take-images';

const NOW = new Date('2026-08-28T10:00:00Z');

/** A planned entry, which is what the importer actually hands this. */
const planned = (slug: string, media: Media[]) => ({ product: product(slug, media) });

const product = (slug: string, media: Media[]): Product => ({
  storeId: 'taz4tech',
  id: `01PRODUCT${slug.toUpperCase().padEnd(17, '0')}`.slice(0, 26),
  slug,
  title: { en: slug },
  description: { en: 'something' },
  brand: null,
  status: 'draft',
  optionNames: [],
  variants: [
    {
      sku: `${slug}-1`,
      options: [],
      price: unwrapOrThrow(fromCents(1000)),
      compareAtPrice: null,
      offerEndsAt: null,
      barcode: null,
      weightGrams: null,
    },
  ],
  media,
  specs: [],
  createdAt: NOW,
  updatedAt: NOW,
});

const image = (url: string): Media => ({
  kind: 'image',
  url,
  alt: { en: 'a picture' },
  width: null,
  height: null,
});

const ingestor = (
  answers: Record<string, { ok: true; path: string } | { ok: false; reason: string }> = {},
): ImageIngestor & { take: ReturnType<typeof vi.fn> } => ({
  // Anything not named in `answers` is taken successfully and lands on the same
  // path. What these tests care about is WHICH urls were fetched and what the
  // products ended up pointing at, never what a hash happens to be.
  take: vi.fn(async (url: string) => answers[url] ?? { ok: true as const, path: '/media/taken' }),
});

describe('taking copies of supplier images', () => {
  it('rewrites the URL to one the shop serves', async () => {
    const ing = ingestor({
      'https://supplier.example.com/a.jpg': { ok: true, path: '/media/abc' },
    });

    const result = await takeImages(
      [planned('laptop', [image('https://supplier.example.com/a.jpg')])],
      ing,
    );

    expect(result.products[0]?.product.media[0]?.url).toBe('/media/abc');
    expect(result.failures).toEqual([]);
  });

  it('keeps everything else about the image, including the alt text', async () => {
    // Alt text is required by the domain and a WCAG failure if it is lost.
    const ing = ingestor();
    const original = { ...image('https://supplier.example.com/a.jpg'), width: 800, height: 600 };

    const result = await takeImages([planned('laptop', [original])], ing);

    expect(result.products[0]?.product.media[0]).toMatchObject({
      alt: { en: 'a picture' },
      width: 800,
      height: 600,
      kind: 'image',
    });
  });

  it('LEAVES OUR OWN PATHS ALONE', async () => {
    // `/media/laptop.png` is a file the shop already serves. Fetching our own
    // path back through the network to store a second copy would be absurd.
    const ing = ingestor();

    const result = await takeImages([planned('laptop', [image('/media/laptop.png')])], ing);

    expect(ing.take).not.toHaveBeenCalled();
    expect(result.products[0]?.product.media[0]?.url).toBe('/media/laptop.png');
  });

  it('fetches a plain http URL, not only https', async () => {
    // Supplier sheets are full of http. Treating only https as foreign leaves
    // those images hotlinked from somebody else's server for ever.
    const ing = ingestor();
    await takeImages([planned('a', [image('http://supplier.example/a.png')])], ing);
    expect(ing.take).toHaveBeenCalledWith('http://supplier.example/a.png');
  });

  it('leaves anything that is not http alone', async () => {
    const ing = ingestor();
    await takeImages([planned('a', [image('data:image/png;base64,AAAA')])], ing);
    expect(ing.take).not.toHaveBeenCalled();
  });

  it('leaves an SVG data URI alone, though it MENTIONS http', async () => {
    /*
     * Every SVG carries `xmlns="http://www.w3.org/2000/svg"`, so a data URI
     * holding one contains the scheme without starting with it. Matching the
     * scheme anywhere in the string rather than at the front sends this to the
     * fetcher, which would then be asked to make an HTTP request for a `data:`
     * URL — the anchor is doing the work, not the alternation.
     */
    const ing = ingestor();
    const svg = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1"/>';
    const result = await takeImages([planned('a', [image(svg)])], ing);

    expect(ing.take).not.toHaveBeenCalled();
    expect(result.products[0]?.product.media[0]?.url).toBe(svg);
    expect(result.taken).toBe(0);
  });
});

describe('a sheet that reuses one photograph', () => {
  it('fetches it ONCE, however many rows name it', async () => {
    /*
     * A four-hundred-row sheet for twenty products shares its photographs
     * heavily, and a supplier CDN does not need four hundred requests to answer
     * twenty questions.
     */
    const ing = ingestor();
    const shared = 'https://supplier.example.com/same.jpg';

    const result = await takeImages(
      [planned('a', [image(shared)]), planned('b', [image(shared)]), planned('c', [image(shared)])],
      ing,
    );

    expect(ing.take).toHaveBeenCalledTimes(1);
    expect(result.taken).toBe(1);
    expect(result.products.map((each) => each.product.media[0]?.url)).toEqual([
      '/media/taken',
      '/media/taken',
      '/media/taken',
    ]);
  });

  it('does not retry a URL that already failed', async () => {
    const ing = ingestor({
      'https://supplier.example.com/gone.jpg': { ok: false, reason: 'the server answered 404' },
    });

    await takeImages(
      [
        planned('a', [image('https://supplier.example.com/gone.jpg')]),
        planned('b', [image('https://supplier.example.com/gone.jpg')]),
      ],
      ing,
    );

    expect(ing.take).toHaveBeenCalledTimes(1);
  });

  it('counts only what it actually took', async () => {
    const ing = ingestor({
      'https://supplier.example.com/gone.jpg': { ok: false, reason: 'gone' },
    });

    const result = await takeImages(
      [
        planned('a', [image('https://supplier.example.com/gone.jpg')]),
        planned('b', [image('https://supplier.example.com/ok.jpg')]),
      ],
      ing,
    );

    expect(result.taken).toBe(1);
  });
});

describe('when an image cannot be taken', () => {
  it('drops it and still imports the product', async () => {
    // A supplier CDN having a bad afternoon must not stop four hundred products
    // from arriving.
    const ing = ingestor({
      'https://supplier.example.com/gone.jpg': { ok: false, reason: 'the server answered 404' },
    });

    const result = await takeImages(
      [planned('laptop', [image('https://supplier.example.com/gone.jpg')])],
      ing,
    );

    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.product.media).toEqual([]);
  });

  it('reports the slug, the URL and why', async () => {
    const ing = ingestor({
      'https://supplier.example.com/gone.jpg': { ok: false, reason: 'the server answered 404' },
    });

    const result = await takeImages(
      [planned('laptop', [image('https://supplier.example.com/gone.jpg')])],
      ing,
    );

    expect(result.failures).toEqual([
      {
        slug: 'laptop',
        url: 'https://supplier.example.com/gone.jpg',
        reason: 'the server answered 404',
      },
    ]);
  });

  it('keeps the images it could take on a product where one failed', async () => {
    // Dropping the whole gallery because the third picture 404ed would lose two
    // perfectly good photographs.
    const ing = ingestor({
      'https://supplier.example.com/b.jpg': { ok: false, reason: 'gone' },
    });

    const result = await takeImages(
      [
        planned('laptop', [
          image('https://supplier.example.com/a.jpg'),
          image('https://supplier.example.com/b.jpg'),
        ]),
      ],
      ing,
    );

    expect(result.products[0]?.product.media).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
  });

  it('reports the same broken URL once per product that names it', async () => {
    // One fetch, but two products lost a picture, and both slugs are worth
    // naming — the operator fixes the sheet by row, not by URL.
    const ing = ingestor({
      'https://supplier.example.com/gone.jpg': { ok: false, reason: 'gone' },
    });

    const result = await takeImages(
      [
        planned('a', [image('https://supplier.example.com/gone.jpg')]),
        planned('b', [image('https://supplier.example.com/gone.jpg')]),
      ],
      ing,
    );

    expect(result.failures.map((each) => each.slug)).toEqual(['a', 'b']);
  });
});

describe('a sheet with no images at all', () => {
  it('does nothing and says so', async () => {
    const ing = ingestor();
    const result = await takeImages([planned('a', [])], ing);

    expect(ing.take).not.toHaveBeenCalled();
    expect(result.taken).toBe(0);
    expect(result.failures).toEqual([]);
  });
});
