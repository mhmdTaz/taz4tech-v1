'use client';

/**
 * The last page before Next's own.
 *
 * This renders when the root layout itself fails — which for this app means the
 * footer's database read threw, since that is the one thing in the layout that
 * can. It replaces the whole document, so it carries its own <html> and <body>
 * and cannot use the site's header, footer, fonts or translations.
 *
 * WHICH IS WHY IT IS IN THREE LANGUAGES AT ONCE.
 *
 * The locale lives in the route segment this boundary sits above, so there is
 * no reliable way to know which one the customer was reading. Guessing English
 * would leave most of this shop's customers looking at a page they cannot read,
 * on the one screen that has to tell them the shop still exists and give them a
 * number to ring. Three short lines is the honest answer to not knowing.
 *
 * The phone number is hard-coded here, alone in this codebase, and deliberately.
 * Everything else reads it from store settings; this page exists precisely for
 * the case where reading store settings is what failed.
 */

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          padding: '2rem',
          background: '#0b0d10',
          color: '#e8eaed',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          lineHeight: 1.6,
        }}
      >
        <main style={{ maxWidth: '30rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.35rem', margin: '0 0 1.25rem', fontWeight: 600 }}>Taz4Tech</h1>

          <p style={{ margin: '0 0 0.75rem' }}>
            Something went wrong at our end. Nothing you did caused it, and no order was placed.
          </p>
          <p dir="rtl" lang="ar" style={{ margin: '0 0 0.75rem' }}>
            حدث خلل عندنا. لم يكن السبب منك، ولم يُسجَّل أي طلب.
          </p>
          <p lang="fr" style={{ margin: '0 0 1.75rem' }}>
            Un problème est survenu chez nous. Vous n'y êtes pour rien, et aucune commande n'a été
            enregistrée.
          </p>

          <p style={{ margin: '0 0 1.75rem' }}>
            <a
              href="tel:+96170000000"
              style={{ color: '#7cc4ff', fontSize: '1.1rem', fontWeight: 600 }}
            >
              +961 70 000 000
            </a>
          </p>

          {/*
            A button, not a link: reset() re-renders without a round trip, which
            is the right first thing to try. With JavaScript unavailable it does
            nothing, so a plain link home sits beside it.
          */}
          <button
            type="button"
            onClick={reset}
            style={{
              font: 'inherit',
              padding: '0.6rem 1.2rem',
              marginInlineEnd: '0.75rem',
              borderRadius: '0.5rem',
              border: '1px solid #2c3238',
              background: '#151a1f',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          <a href="/en" style={{ color: '#9aa4ae' }}>
            Home
          </a>
        </main>
      </body>
    </html>
  );
}
