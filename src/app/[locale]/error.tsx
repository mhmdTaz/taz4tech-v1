'use client';

/**
 * A storefront page that threw.
 *
 * Distinct from global-error.tsx above it: this one sits INSIDE the locale
 * layout, so the header, the footer and the customer's own language all still
 * work. They can carry on shopping, which is the difference between a page that
 * failed and a shop that appears to have closed.
 *
 * It never shows the error. A stack trace on a storefront tells a customer
 * nothing they can use and tells everybody else the shape of the software; the
 * detail is already in the log, structured and redacted, put there by
 * onRequestError.
 */

import { useTranslations } from 'next-intl';

export default function StorefrontError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('error');

  return (
    <main className="mx-auto flex max-w-2xl flex-col items-start gap-5 px-6 py-20">
      <h1 className="text-3xl font-semibold tracking-tight text-ink">{t('title')}</h1>
      <p className="text-base text-muted">{t('body')}</p>

      <div className="flex flex-wrap items-center gap-4">
        {/*
          reset() re-renders the segment without a round trip, which is the right
          first thing to try. It needs JavaScript, so a plain link sits beside it
          for the case where the page arrived before the script did.
        */}
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-void transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t('retry')}
        </button>
        <a
          href="/"
          className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t('home')}
        </a>
      </div>
    </main>
  );
}
