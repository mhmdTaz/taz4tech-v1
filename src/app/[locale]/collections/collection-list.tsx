import { isFullyCurated } from '@modules/catalog';
import type { Locale } from '@platform/locale';
import { textFor } from '@platform/locale';
import { Panel } from '@ui/primitives/panel';
import { connection } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getContainer } from '@/composition';

/**
 * The collection index.
 *
 * Only published collections appear — the use case defaults to active-only and
 * the status parameter cannot reach around it.
 */
export const CollectionList = async ({ locale }: { locale: Locale }) => {
  await connection();
  const t = await getTranslations({ locale, namespace: 'collections' });

  let collections: Awaited<ReturnType<typeof load>>;
  try {
    collections = await load();
  } catch {
    return (
      <Panel>
        <p className="text-sm text-negative">{t('loadFailed')}</p>
      </Panel>
    );
  }

  if (collections.length === 0) {
    return (
      <Panel>
        <p className="text-sm text-muted">{t('empty')}</p>
      </Panel>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {collections.map((collection) => (
        <li key={collection.id}>
          <a
            href={`/${locale}/collections/${collection.slug}`}
            className="flex h-full flex-col gap-2 rounded-[var(--radius-panel)] border border-hairline bg-surface p-6 transition-colors hover:border-accent-dim focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <h2 className="text-base font-medium text-ink">{textFor(collection.title, locale)}</h2>
            <p className="text-sm leading-relaxed text-muted">
              {textFor(collection.description, locale)}
            </p>
            {isFullyCurated(collection) && (
              <p className="mt-auto pt-3 text-xs uppercase tracking-widest text-faint">
                {t('curated')}
              </p>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
};

const load = async () => {
  const container = await getContainer();
  return container.catalog.listCollections();
};
