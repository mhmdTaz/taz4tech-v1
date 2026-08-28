import type { ReactNode } from 'react';

/**
 * The filter sidebar.
 *
 * Every control is a LINK, not a checkbox in a form. That makes each filtered
 * view a real URL — shareable, bookmarkable, crawlable, and usable before (or
 * without) JavaScript. A checkbox that needs an onChange handler is a filter
 * that does nothing on a slow connection.
 *
 * Pure presentation: it receives already-translated labels and pre-built hrefs.
 */

export type FacetOption = {
  readonly value: string;
  readonly label: string;
  readonly count: number;
  readonly href: string;
  readonly selected: boolean;
};

/**
 * Visually-hidden state, appended to the accessible name.
 *
 * The tick box and the colour say "selected" to a sighted user. Without this a
 * screen reader announces only "Lenovo, 2" whether the filter is on or off.
 */
const SelectedState = ({ label }: { label: string }) => <span className="sr-only">{label}</span>;

export const FacetGroup = ({
  legend,
  options,
  selectedLabel,
}: {
  legend: string;
  options: readonly FacetOption[];
  /** Translated, e.g. "selected". Announced after the facet name. */
  selectedLabel: string;
}) => {
  if (options.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      {/*
        h2, not h3. The listing's own title is the h1 and there is nothing
        between it and these, so an h3 skips a level — which Lighthouse's
        heading-order audit catches and a screen-reader user navigating by
        structure experiences as a missing rung on the ladder. The desktop
        preset never surfaced it because it never ran this audit differently;
        the mobile switch did.
      */}
      <h2 className="text-xs font-medium uppercase tracking-widest text-faint">{legend}</h2>
      <ul className="flex flex-col gap-1">
        {options.map((option) => (
          <li key={option.value}>
            <a
              href={option.href}
              /*
               * aria-current, NOT aria-pressed.
               *
               * aria-pressed is only valid on elements with a button role, and
               * axe flags it as a critical violation on a link — which these
               * deliberately are, because each filtered view is a real URL. The
               * state is also spelled out in the accessible name below, since
               * aria-current alone is announced inconsistently across readers.
               */
              {...(option.selected ? { 'aria-current': true as const } : {})}
              className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                option.selected
                  ? 'bg-accent/10 text-accent'
                  : 'text-muted hover:bg-raised hover:text-ink'
              }`}
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`inline-block size-3.5 shrink-0 rounded-[4px] border ${
                    option.selected ? 'border-accent bg-accent' : 'border-hairline'
                  }`}
                />
                {option.label}
                {option.selected && <SelectedState label={selectedLabel} />}
              </span>
              <span className="tabular-nums text-xs text-faint">{option.count}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
};

export const FacetPanel = ({
  label,
  children,
  clearHref,
  clearLabel,
}: {
  label: string;
  children: ReactNode;
  /** Present only when something is actually filtering. */
  clearHref?: string;
  clearLabel: string;
}) => (
  <aside aria-label={label} className="flex flex-col gap-6">
    {clearHref !== undefined && (
      <a
        href={clearHref}
        className="self-start text-sm text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {clearLabel}
      </a>
    )}
    {children}
  </aside>
);

/**
 * The search box.
 *
 * A plain GET form, so submitting it produces a URL. No JavaScript is involved
 * in searching at all.
 */
export const SearchBox = ({
  action,
  label,
  placeholder,
  submitLabel,
  defaultValue,
}: {
  action: string;
  label: string;
  placeholder: string;
  submitLabel: string;
  defaultValue: string;
}) => (
  // <search> rather than role="search" on the form: the native element carries
  // the role implicitly, and Biome rejects the ARIA attribute where an element
  // exists that means the same thing.
  <search>
    <form action={action} method="get" className="flex gap-2">
      <label className="sr-only" htmlFor="product-search">
        {label}
      </label>
      <input
        id="product-search"
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="min-w-0 flex-1 rounded-full border border-hairline bg-surface px-5 py-3 text-sm text-ink placeholder:text-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
      <button
        type="submit"
        className="rounded-full border border-hairline px-5 py-3 text-sm font-medium text-ink transition-colors hover:border-accent-dim hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {submitLabel}
      </button>
    </form>
  </search>
);
