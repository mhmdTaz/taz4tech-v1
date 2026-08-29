'use client';

import type { QuickView, QuickViewVariant } from '@modules/catalog';
import type { Locale } from '@platform/locale';
import { format as formatMoney } from '@platform/money';
import Image from 'next/image';
import {
  createContext,
  type MouseEvent,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

/**
 * Quick view: a peek at a product without leaving the grid.
 *
 * NO FETCH, NO ENDPOINT
 * ---------------------
 * The listing has already loaded every product on the page in order to render
 * the tiles, so the dialog's data is shipped WITH the page rather than fetched
 * when it opens. That removes a round trip on exactly the connection this
 * feature exists to be gentle with — a "quick" view that spends a second on the
 * network is not quick — and with it an endpoint, a loading state and an error
 * state. The cost is a few kilobytes of payload whether or not anyone opens one.
 *
 * ONE DIALOG, NOT ONE PER TILE
 * ----------------------------
 * Twenty-four dialogs in the DOM would be twenty-four sets of listeners and a
 * lot of duplicated markup. The provider owns a single <dialog>; the tiles own
 * only a trigger.
 *
 * WHY <dialog> RATHER THAN A DIV
 * ------------------------------
 * showModal() gives focus trapping, Escape to dismiss, inert background and
 * focus restored to the trigger — all of it native, none of it re-implemented
 * slightly wrong. Reaching for a div here means writing a focus trap, and a
 * hand-written focus trap is where keyboard users actually get stuck.
 *
 * The URL does NOT change while the dialog is open. It is a transient peek; the
 * tile link is the thing that is shareable, indexable and back-navigable. Making
 * the dialog a history entry would mean a client navigation — and on a route
 * that renders from the database, a wasted round trip every time one is closed.
 */

export type QuickViewLabels = {
  readonly quickView: string;
  readonly quickViewOf: string;
  readonly close: string;
  readonly fullDetails: string;
  readonly hint: string;
  readonly priceWas: string;
  readonly priceNow: string;
  readonly offerEnds: string;
  readonly chooseOption: string;
  readonly sku: string;
  readonly inStock: string;
  readonly outOfStock: string;
};

type QuickViewContextValue = {
  readonly open: (slug: string) => void;
  readonly label: string;
};

const QuickViewContext = createContext<QuickViewContextValue | null>(null);

/**
 * The trigger on a tile.
 *
 * Rendered as a LINK to the full product page, always. Without JavaScript — or
 * before hydration, which on a slow connection is a real slice of the first
 * interactions — clicking it navigates, which is a worse experience but never a
 * broken one. Modifier-clicks are left alone too, so "open in new tab" keeps
 * working the way a link is supposed to.
 */
export const QuickViewTrigger = ({ slug, href }: { slug: string; href: string }) => {
  const context = useContext(QuickViewContext);

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // No provider means no dialog: let the link be a link.
    if (context === null) return;
    // Middle click, ctrl/cmd click, shift click — all of them mean "not here".
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }

    event.preventDefault();
    context.open(slug);
  };

  return (
    <a
      href={href}
      onClick={onClick}
      // It still navigates without JavaScript, so it stays a link — but a screen
      // reader should be told a dialog is what usually happens.
      aria-haspopup="dialog"
      className="pointer-events-auto rounded-full border border-hairline bg-void/80 px-3 py-1.5 text-xs font-medium text-ink backdrop-blur transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {context?.label ?? ''}
    </a>
  );
};

const money = (cents: number, currency: 'USD', locale: Locale) =>
  formatMoney({ cents, currency }, locale);

/** The variant reached by changing ONE option and keeping the rest. */
const variantFor = (
  view: QuickView,
  current: QuickViewVariant,
  optionName: string,
  value: string,
): QuickViewVariant | undefined => {
  const wanted = current.options.map((option) =>
    option.name === optionName ? { name: option.name, value } : option,
  );

  return view.variants.find((candidate) =>
    wanted.every((option) =>
      candidate.options.some(
        (candidateOption) =>
          candidateOption.name === option.name && candidateOption.value === option.value,
      ),
    ),
  );
};

const valuesFor = (view: QuickView, optionName: string): string[] => [
  ...new Set(
    view.variants.flatMap((variant) =>
      variant.options.filter((option) => option.name === optionName).map((option) => option.value),
    ),
  ),
];

const OptionPicker = ({
  view,
  selected,
  labels,
  onSelect,
}: {
  view: QuickView;
  selected: QuickViewVariant;
  labels: QuickViewLabels;
  onSelect: (variant: QuickViewVariant) => void;
}) => (
  <div className="flex flex-col gap-4">
    {view.optionNames.map((optionName) => (
      <fieldset key={optionName} className="flex flex-col gap-2 border-0 p-0">
        <legend className="text-sm font-medium text-muted">
          {labels.chooseOption.replace('{option}', optionName)}
        </legend>
        <ul className="flex flex-wrap gap-2">
          {valuesFor(view, optionName).map((value) => {
            const target = variantFor(view, selected, optionName, value);
            const isSelected = selected.options.some(
              (option) => option.name === optionName && option.value === value,
            );
            /*
             * Sold out is NOT disabled.
             *
             * A combination that does not exist can never be bought, so it is
             * disabled. One that exists but has run out is a thing the customer
             * may well want to look at — the price, the photo, whether to wait —
             * so it stays selectable and says so when chosen.
             */
            const soldOut = target !== undefined && target.availability === 'out_of_stock';

            /*
             * Inside a transient dialog the selection is CLIENT state, not a
             * URL — there is no address here to own. The product page does the
             * opposite, deliberately: there the combination has to be shareable
             * and crawlable, so each value is a link.
             */
            return (
              <li key={value}>
                <button
                  type="button"
                  disabled={target === undefined}
                  aria-pressed={isSelected}
                  onClick={() => {
                    if (target !== undefined) onSelect(target);
                  }}
                  className={`rounded-full border px-3.5 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-faint disabled:line-through ${
                    isSelected
                      ? 'border-accent bg-accent/10 text-accent'
                      : soldOut
                        ? 'border-hairline text-faint hover:border-accent-dim'
                        : 'border-hairline text-ink hover:border-accent-dim hover:text-accent'
                  }`}
                >
                  {value}
                  {soldOut && <span className="sr-only"> — {labels.outOfStock}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </fieldset>
    ))}
  </div>
);

const Body = ({
  view,
  locale,
  labels,
}: {
  view: QuickView;
  locale: Locale;
  labels: QuickViewLabels;
}) => {
  const [sku, setSku] = useState(view.defaultSku);
  const selected = view.variants.find((variant) => variant.sku === sku) ?? view.variants[0];

  // A product with no variants cannot exist — the domain refuses it — but the
  // wire type cannot say so, and rendering nothing beats rendering undefined.
  if (selected === undefined) return null;

  const hero = view.images[0];
  const onOffer = selected.compareAtCents !== null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 sm:flex-row">
        {/*
          No aria-label on this wrapper: it has no role, so one would not be
          exposed anyway. The image's own alt text is what describes it, and a
          single-image container needs no group label on top of that.
        */}
        <div className="relative aspect-4/3 w-full shrink-0 overflow-hidden rounded-[var(--radius-panel)] border border-hairline bg-raised sm:w-56">
          {hero === undefined ? (
            <div
              aria-hidden="true"
              className="h-full w-full bg-linear-to-br from-raised to-surface"
            />
          ) : (
            // The dialog is at most half a phone screen and a third of a desktop
            // one, and it opens on demand — so it is never the LCP element and
            // never needs a priority hint.
            <Image
              src={hero.url}
              alt={hero.alt}
              fill
              sizes="(min-width: 640px) 320px, 50vw"
              className="object-cover"
            />
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          {view.brand !== null && (
            <p className="text-xs uppercase tracking-widest text-faint">{view.brand}</p>
          )}
          <h2 className="text-xl font-semibold tracking-tight text-ink">{view.title}</h2>

          <p className="flex flex-wrap items-baseline gap-2">
            {onOffer && selected.compareAtCents !== null && (
              <span className="text-sm text-faint line-through">
                <span className="sr-only">{labels.priceWas} </span>
                {money(selected.compareAtCents, view.currency, locale)}
              </span>
            )}
            <span className={`text-lg font-semibold ${onOffer ? 'text-caution' : 'text-ink'}`}>
              {onOffer && <span className="sr-only">{labels.priceNow} </span>}
              {money(selected.priceCents, view.currency, locale)}
            </span>
          </p>

          {selected.offerEndsAt !== null && (
            // The expiry is rendered wherever the offer is: consumer protection
            // law requires it to be SHOWN, not merely stored.
            <p className="text-sm text-caution">
              {labels.offerEnds.replace(
                '{date}',
                new Intl.DateTimeFormat(locale, {
                  dateStyle: 'long',
                  timeZone: 'Asia/Beirut',
                  numberingSystem: 'latn',
                }).format(new Date(selected.offerEndsAt)),
              )}
            </p>
          )}

          {/*
            A status region: it changes when the customer picks another option,
            and that change is exactly what they are asking about.
          */}
          <p
            role="status"
            className={`text-sm font-medium ${
              selected.availability === 'in_stock' ? 'text-positive' : 'text-negative'
            }`}
          >
            {selected.availability === 'in_stock' ? labels.inStock : labels.outOfStock}
          </p>

          <p className="text-sm text-muted">
            <span className="text-faint">{labels.sku} </span>
            <span className="font-mono text-ink">{selected.sku}</span>
          </p>
        </div>
      </div>

      {view.optionNames.length > 0 && (
        <OptionPicker
          view={view}
          selected={selected}
          labels={labels}
          onSelect={(variant) => setSku(variant.sku)}
        />
      )}

      <p className="max-h-32 overflow-y-auto text-sm leading-relaxed text-muted">
        {view.description}
      </p>

      <p className="text-xs text-faint">{labels.hint}</p>
    </div>
  );
};

export const QuickViewProvider = ({
  views,
  locale,
  labels,
  children,
}: {
  readonly views: readonly QuickView[];
  readonly locale: Locale;
  readonly labels: QuickViewLabels;
  readonly children: React.ReactNode;
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [slug, setSlug] = useState<string | null>(null);

  /*
   * Marks the moment the triggers start intercepting clicks.
   *
   * Before hydration a trigger is a plain link and following it is the CORRECT
   * outcome — that is the whole progressive-enhancement story, and there is
   * deliberately no visible difference between "not upgraded yet" and
   * "upgraded". Which leaves a test that clicks one no way to tell whether it
   * is about to get a dialog or a navigation, and that raced: the e2e suite
   * flaked three times over several weeks, landing on the product page with no
   * dialog and no explanation.
   *
   * So the state is made observable rather than guessed at. Nothing renders
   * differently; `data-ready` simply appears once React has attached handlers.
   */
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const open = useCallback((next: string) => {
    setSlug(next);
    dialogRef.current?.showModal();
  }, []);

  // Driven by the dialog's own close event rather than by the buttons, so
  // Escape, the close button and a backdrop click all land in one place.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;

    const onClose = () => setSlug(null);
    dialog.addEventListener('close', onClose);
    return () => dialog.removeEventListener('close', onClose);
  }, []);

  const view = views.find((candidate) => candidate.slug === slug) ?? null;

  return (
    <QuickViewContext.Provider value={{ open, label: labels.quickView }}>
      {children}

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled natively by <dialog> */}
      <dialog
        ref={dialogRef}
        data-ready={ready ? '' : undefined}
        /*
          Named "Quick view: Anker Cable" rather than by the heading alone. A
          screen reader announces a dialog by its name on open, and "Anker Cable"
          on its own does not say what just happened.
        */
        aria-label={view === null ? undefined : labels.quickViewOf.replace('{title}', view.title)}
        onClick={(event) => {
          // A click on the dialog element itself is a click on the backdrop:
          // everything inside is a child, so it never reports as the target.
          if (event.target === dialogRef.current) dialogRef.current?.close();
        }}
        className="m-auto w-[min(48rem,calc(100vw-2rem))] rounded-[var(--radius-panel)] border border-hairline bg-surface p-0 text-ink backdrop:bg-void/70 backdrop:backdrop-blur-sm"
      >
        {view !== null && (
          <div className="flex flex-col gap-5 p-6">
            <Body view={view} locale={locale} labels={labels} />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <a
                href={view.href}
                className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-void transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {labels.fullDetails}
              </a>
              <button
                type="button"
                onClick={() => dialogRef.current?.close()}
                className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {labels.close}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </QuickViewContext.Provider>
  );
};
