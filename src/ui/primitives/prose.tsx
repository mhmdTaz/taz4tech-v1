import type { ReactNode } from 'react';

/**
 * The furniture the shop's written pages are made of.
 *
 * Delivery, returns, terms, privacy and contact are the same page five times:
 * a title, a standfirst, then headed sections of plain paragraphs. Building
 * each one out of raw divs would mean five chances to set a different measure
 * or a different heading size, and a customer reading two of them in a row
 * would notice.
 *
 * Pure presentation, like everything in this folder — the boundary check forbids
 * importing a module here at all, so nothing on this page can accidentally start
 * reading a database.
 */

/** Around 70 characters at the body size. Longer lines lose the reader's place. */
const MEASURE = 'max-w-[68ch]';

export const PageHeader = ({ title, standfirst }: { title: ReactNode; standfirst?: ReactNode }) => (
  <header className="flex flex-col gap-3">
    <h1 className="text-balance text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
      {title}
    </h1>
    {standfirst !== undefined && <p className={`${MEASURE} text-lg text-muted`}>{standfirst}</p>}
  </header>
);

/**
 * One headed section of a written page.
 *
 * The heading is an `h2` and never anything else: these pages have exactly two
 * levels, and a page whose headings skip a level is a page a screen-reader user
 * cannot navigate by structure.
 */
export const Section = ({ heading, children }: { heading: ReactNode; children: ReactNode }) => (
  <section className="flex flex-col gap-3 border-t border-hairline pt-6">
    <h2 className="text-lg font-semibold text-ink">{heading}</h2>
    <div className={`${MEASURE} flex flex-col gap-3 text-base leading-relaxed text-muted`}>
      {children}
    </div>
  </section>
);

/** A numbered sequence — used where the order is the information, as on delivery. */
export const Steps = ({ children }: { children: ReactNode }) => (
  <ol
    className={`${MEASURE} flex list-decimal flex-col gap-3 ps-5 text-base leading-relaxed text-muted marker:text-accent marker:font-medium`}
  >
    {children}
  </ol>
);

/**
 * A link styled as a button.
 *
 * An anchor rather than a `button`, because every one of these navigates. A
 * `button` that navigates is a control a keyboard user cannot open in a new tab
 * and a screen reader announces as the wrong thing.
 */
export const ButtonLink = ({
  href,
  tone = 'accent',
  children,
}: {
  href: string;
  tone?: 'accent' | 'quiet';
  children: ReactNode;
}) => (
  <a
    href={href}
    className={`inline-flex items-center gap-2 self-start rounded-lg px-4 py-2.5 text-sm font-medium transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
      tone === 'accent'
        ? 'bg-accent text-void'
        : 'border border-hairline text-ink hover:border-accent'
    }`}
  >
    {children}
  </a>
);

/** The shell every written page sits in, so the measure and rhythm are set once. */
export const WrittenPage = ({ children }: { children: ReactNode }) => (
  <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12 sm:py-16">{children}</main>
);
