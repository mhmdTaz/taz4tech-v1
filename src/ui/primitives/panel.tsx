import type { ReactNode } from 'react';

/**
 * A bordered surface. Pure presentation: it takes children and a heading, and
 * knows nothing about where the content came from — the boundary check forbids
 * this folder from importing a module at all.
 */
export const Panel = ({ heading, children }: { heading?: ReactNode; children: ReactNode }) => (
  <section className="rounded-[var(--radius-panel)] border border-hairline bg-surface p-6">
    {heading !== undefined && (
      <h2 className="mb-4 text-sm font-medium uppercase tracking-widest text-faint">{heading}</h2>
    )}
    {children}
  </section>
);

/** A label/value row that mirrors correctly in Arabic via logical properties. */
export const Field = ({ label, children }: { label: ReactNode; children: ReactNode }) => (
  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-hairline py-3 last:border-b-0">
    <dt className="text-sm text-muted">{label}</dt>
    <dd className="text-sm font-medium text-ink">{children}</dd>
  </div>
);
