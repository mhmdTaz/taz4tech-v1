import { showsRegistryNumber } from '@modules/store';
import type { Locale } from '@platform/locale';
import { formatForDisplay } from '@platform/phone';
import { connection } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getContainer } from '@/composition';
import { LanguageSwitcher } from './language-switcher';

/**
 * The bottom of every page, and the only place the shop says who it is.
 *
 * That is not decoration. Law 81/2018 Art. 31 wants the seller identified on the
 * storefront, and until now the only place that happened was a configuration
 * panel on the home page — which exists to be deleted. The name, the commercial
 * registry number and a number a customer can actually ring live here instead,
 * on every page rather than one.
 *
 * Everything shown is read from the settings the admin edits, so changing the
 * shop's phone number is one form and not a deploy.
 */
export const SiteFooter = async ({ locale }: { locale: Locale }) => {
  /*
   * Opt out of prerendering, the same way the store summary does.
   *
   * Without this the BUILD tries to render this component, and a build machine
   * has no business connecting to a production database to generate a page —
   * which is exactly what happened: the local build passed because Mongo was
   * running on the machine, and CI's build job, which deliberately has no
   * database, died on ECONNREFUSED while exporting /ar.
   *
   * The store summary got this for free from the Suspense boundary around it.
   * This footer has none, on purpose — see the layout — so it has to say so.
   */
  await connection();

  const t = await getTranslations({ locale, namespace: 'footer' });
  const tNav = await getTranslations({ locale, namespace: 'nav' });
  const tDelivery = await getTranslations({ locale, namespace: 'delivery' });
  const tReturns = await getTranslations({ locale, namespace: 'returns' });
  const tTerms = await getTranslations({ locale, namespace: 'terms' });
  const tPrivacy = await getTranslations({ locale, namespace: 'privacy' });
  const tContact = await getTranslations({ locale, namespace: 'contact' });

  const container = await getContainer();
  const settings = await container.store.getStoreSettings();
  const shop = settings.ok ? settings.value : null;

  /*
   * The shop's name from settings, falling back to the brand in the header.
   * A footer that renders an empty space where the shop's name should be is
   * worse than one that repeats what the logo already says.
   */
  const name = shop?.name ?? 'Taz4Tech';

  const link =
    'text-sm text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

  const groups = [
    {
      heading: t('shop'),
      links: [
        { href: `/${locale}/products`, label: tNav('products') },
        { href: `/${locale}/collections`, label: tNav('collections') },
      ],
    },
    {
      heading: t('help'),
      links: [
        { href: `/${locale}/delivery`, label: tDelivery('title') },
        { href: `/${locale}/returns`, label: tReturns('title') },
        { href: `/${locale}/contact`, label: tContact('title') },
      ],
    },
    {
      heading: t('legal'),
      links: [
        { href: `/${locale}/terms`, label: tTerms('title') },
        { href: `/${locale}/privacy`, label: tPrivacy('title') },
      ],
    },
  ];

  return (
    // No aria-label: a <footer> that is a child of <body> already exposes
    // role="contentinfo", there is exactly one on the page, and a redundant
    // label is one more string to translate for no reader's benefit.
    <footer className="mt-16 border-hairline border-t bg-surface/40">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-12">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold tracking-tight text-ink">{name}</p>
            <p className="max-w-[34ch] text-sm text-muted">{t('tagline')}</p>
          </div>

          {groups.map((group) => (
            <nav key={group.heading} aria-label={group.heading} className="flex flex-col gap-3">
              <h2 className="text-xs font-medium uppercase tracking-widest text-faint">
                {group.heading}
              </h2>
              <ul className="flex flex-col gap-2">
                {group.links.map((each) => (
                  <li key={each.href}>
                    <a href={each.href} className={link}>
                      {each.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="flex flex-col gap-4 border-hairline border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1 text-sm text-faint">
            {/*
              The year comes from the clock in the container rather than from
              `new Date()` here, so the one place this app decides what time it
              is stays the one place.
            */}
            <p>{t('rights', { year: container.clock.now().getFullYear(), name })}</p>
            {shop !== null && showsRegistryNumber(shop) && (
              <p>{t('registry', { number: shop.commercialRegistryNumber ?? '' })}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            {shop !== null && (
              <a
                href={`tel:${shop.contactPhone}`}
                className="text-sm text-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span className="text-faint">{t('callUs')} </span>
                <span dir="ltr" className="font-mono">
                  {formatForDisplay(shop.contactPhone)}
                </span>
              </a>
            )}

            <LanguageSwitcher current={locale} label={t('language')} />
          </div>
        </div>
      </div>
    </footer>
  );
};
