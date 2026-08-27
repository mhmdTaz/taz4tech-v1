import type { ReactNode } from 'react';

/**
 * A product tile for a listing page.
 *
 * Pure presentation: it takes a href, some already-translated strings and a
 * price node. It does not know what a Product is — the boundary check forbids
 * this folder from importing a module at all.
 *
 * The whole card is one link rather than a card containing a link. A grid of
 * tiles where only the title is clickable is the single most common reason a
 * product listing tests badly on mobile.
 */
export const ProductCard = ({
  href,
  title,
  brand,
  image,
  price,
  badge,
  action,
}: {
  href: string;
  title: string;
  brand?: string | null;
  image?: { src: string; alt: string } | null;
  price: ReactNode;
  badge?: ReactNode;
  /**
   * A control overlaid on the tile — the quick-view trigger.
   *
   * Rendered as a SIBLING of the card link, never inside it. An interactive
   * element nested in an anchor is invalid HTML, and browsers resolve it by
   * making one of the two unreachable; which one varies. Keeping it outside
   * preserves the property this card is built around — the whole tile is one
   * link — while still letting something sit on top of it.
   */
  action?: ReactNode;
}) => (
  <div className="relative h-full">
    <a
      href={href}
      className="group flex flex-col overflow-hidden rounded-[var(--radius-panel)] border border-hairline bg-surface transition-colors hover:border-accent-dim focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <div className="relative aspect-4/3 overflow-hidden bg-raised">
        {image ? (
          // next/image needs remote patterns configured per host, and which hosts
          // serve catalogue media is a Phase 3 settings decision. Plain img until then.
          // biome-ignore lint/performance/noImgElement: media hosts are a Phase 3 settings decision
          <img
            src={image.src}
            alt={image.alt}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          // An empty frame rather than a broken-image icon or a stretched
          // placeholder photo: an unillustrated product should look deliberate.
          <div
            aria-hidden="true"
            className="h-full w-full bg-linear-to-br from-raised to-surface"
          />
        )}
        {badge !== undefined && <div className="absolute start-3 top-3">{badge}</div>}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        {brand !== null && brand !== undefined && brand.length > 0 && (
          <p className="text-xs uppercase tracking-widest text-faint">{brand}</p>
        )}
        <h3 className="text-sm font-medium leading-snug text-ink group-hover:text-accent">
          {title}
        </h3>
        <div className="mt-auto pt-2">{price}</div>
      </div>
    </a>

    {action !== undefined && (
      // pointer-events-none on the wrapper so the rest of the tile stays
      // clickable; the control itself turns them back on.
      <div className="pointer-events-none absolute end-3 top-3 flex">{action}</div>
    )}
  </div>
);

/** A small pill, e.g. "Sale". Colour carries no meaning on its own — the text does. */
export const Badge = ({
  children,
  tone = 'accent',
}: {
  children: ReactNode;
  tone?: 'accent' | 'caution';
}) => {
  const tones = {
    accent: 'bg-accent/15 text-accent ring-accent/30',
    caution: 'bg-caution/15 text-caution ring-caution/30',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
};
