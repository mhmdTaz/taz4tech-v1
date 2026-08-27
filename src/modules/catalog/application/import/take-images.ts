/**
 * Replacing supplier image URLs with the shop's own copies, at import time.
 *
 * The planner is pure and stays that way, so it produces products still pointing
 * at whatever the spreadsheet said. This runs once on the way to the write, and
 * is the step where the catalogue stops depending on somebody else's server.
 *
 * WHAT IT REFUSES TO TOUCH
 * ------------------------
 * Anything that is not an absolute http(s) URL. A sheet that says
 * `/media/laptop.png` is naming a file the shop already serves, and fetching our
 * own path back through the network to store a second copy of it would be
 * absurd. Those pass through unchanged.
 *
 * ONE FETCH PER DISTINCT URL, NOT ONE PER ROW
 * -------------------------------------------
 * A four-hundred-row sheet for a catalogue of twenty products shares its
 * photographs heavily, and a supplier CDN does not need four hundred requests to
 * answer twenty questions. The results are memoised across the whole import, so
 * a URL that failed is also not retried thirty times.
 *
 * A FAILURE COSTS ONE PICTURE, NEVER THE IMPORT
 * ---------------------------------------------
 * An image that cannot be fetched is dropped from that product and reported by
 * slug, URL and reason. The product still imports. A supplier CDN having a bad
 * afternoon must not be able to stop four hundred products from arriving, and
 * re-importing the same sheet later picks up whatever has come back.
 */

import type { ImageIngestor } from '../../contracts';
import type { Media, Product } from '../../domain/product';

export type ImageFailure = {
  readonly slug: string;
  readonly url: string;
  readonly reason: string;
};

export type TakenImages<T> = {
  /** The SAME entries, in the same order, with each product's media rewritten. */
  readonly products: readonly T[];
  readonly failures: readonly ImageFailure[];
  /** Distinct URLs actually fetched. Zero when a sheet reuses images already stored. */
  readonly taken: number;
};

/** Ours already, or a data URI, or something we have no business fetching. */
const isForeign = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * Generic over the planned entry, so what goes in comes back out.
 *
 * The alternative — take products, return products, and have the caller pair
 * them up again by slug — needs a lookup that can miss, and a fallback for a
 * miss that cannot happen. Keeping the caller's own objects means there is
 * nothing to re-associate and no branch to leave uncovered.
 */
export const takeImages = async <T extends { readonly product: Product }>(
  planned: readonly T[],
  ingestor: ImageIngestor,
): Promise<TakenImages<T>> => {
  const resolved = new Map<string, { ok: true; path: string } | { ok: false; reason: string }>();
  const failures: ImageFailure[] = [];

  const rewritten: T[] = [];

  for (const entry of planned) {
    const product = entry.product;
    const media: Media[] = [];

    for (const item of product.media) {
      if (!isForeign(item.url)) {
        media.push(item);
        continue;
      }

      let outcome = resolved.get(item.url);
      if (outcome === undefined) {
        outcome = await ingestor.take(item.url);
        resolved.set(item.url, outcome);
      }

      if (outcome.ok) {
        media.push({ ...item, url: outcome.path });
        continue;
      }

      // Dropped, not kept-and-broken: a product with no picture renders a
      // placeholder, and a product pointing at a 404 renders a broken image.
      failures.push({ slug: product.slug, url: item.url, reason: outcome.reason });
    }

    rewritten.push({ ...entry, product: { ...product, media } });
  }

  return {
    products: rewritten,
    failures,
    taken: [...resolved.values()].filter((outcome) => outcome.ok).length,
  };
};
