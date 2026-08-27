import { IMPORT_FIELDS, REQUIRED_FIELDS } from '@modules/catalog';
import { notFound } from 'next/navigation';
import { getContainer } from '@/composition';
import { logOut } from '../login/actions';
import { requireAdmin } from '../session';
import { Importer } from './importer';

/** Reads a cookie and a feature flag, so there is nothing here to prerender. */
export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  // The gate lives here, on the page itself — not in the layout above it. See
  // the note in ../session.ts for why that distinction is not cosmetic.
  await requireAdmin();

  const container = await getContainer();
  if (!container.flags.isOn('excelImporter')) notFound();

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Import catalogue</h1>
          <p className="text-sm text-muted">
            Upload a price list, check what it would do, then import.
          </p>
        </div>

        <form action={logOut}>
          <button
            type="submit"
            className="rounded-lg border border-hairline px-3 py-2 text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Sign out
          </button>
        </form>
      </header>

      {/*
        Handed down rather than imported by the client component: a value import
        from the catalogue barrel would pull its infrastructure ring into the
        browser bundle, and the build fails on node:zlib. See importer.tsx.
      */}
      <Importer fields={IMPORT_FIELDS} requiredFields={REQUIRED_FIELDS} />
    </main>
  );
}
