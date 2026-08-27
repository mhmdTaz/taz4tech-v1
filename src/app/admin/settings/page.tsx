import { type StoreSettingsForm, toForm } from '@modules/store';
import { LOCALES } from '@platform/locale';
import { getContainer } from '@/composition';
import { AdminNav } from '../nav';
import { requireAdmin } from '../session';
import { saveSettings } from './actions';

/** Reads a cookie and the database on every request. */
export const dynamic = 'force-dynamic';

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const input =
  'w-full rounded-lg border border-hairline bg-raised px-3 py-2.5 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

const MESSAGES: Record<string, string> = {
  phone: 'That phone number could not be read. Write it as 03 123 456 or +961 3 123 456.',
  vat: 'The VAT rate has to be a percentage between 0 and 100, written like 11 or 11.5.',
  fee: 'The delivery fee has to be an amount of zero or more, written like 3 or 3.50.',
  name: 'The shop needs a name.',
  not_configured: 'This store has not been seeded yet, so there is nothing to edit.',
  stored: 'The stored settings are invalid in a way this form cannot fix. Check the seed.',
};

export default async function AdminSettingsPage({ searchParams }: PageProps) {
  // On the page itself, not the layout. See ../session.ts.
  await requireAdmin();

  const query = await searchParams;
  const container = await getContainer();
  const settings = await container.store.getStoreSettings();

  const importer = container.flags.isOn('excelImporter');

  if (!settings.ok) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
        <Header importer={importer} />
        <p className="rounded-[var(--radius-panel)] border border-caution/60 bg-surface p-5 text-sm text-caution">
          {settings.error.tag === 'store_not_configured'
            ? `No settings for store "${settings.error.storeId}". Run the seed before editing them.`
            : 'The settings could not be read.'}
        </p>
      </main>
    );
  }

  const error = one(query.error);
  const saved = one(query.saved) !== undefined;

  /*
   * What was typed wins over what is stored, but only after a refusal.
   *
   * On a normal visit the query string is empty and every box shows the stored
   * value; after a refusal the boxes show what the operator wrote, so the one
   * they have to fix is the only one they touch.
   */
  const stored = toForm(settings.value);
  const value = (name: keyof StoreSettingsForm): string => one(query[name]) ?? stored[name];

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      <Header importer={importer} />

      {saved && (
        <p
          role="status"
          className="rounded-[var(--radius-panel)] border border-positive/60 bg-surface p-4 text-sm text-positive"
        >
          Saved. The storefront is showing this now.
        </p>
      )}

      {error !== undefined && (
        <p
          role="alert"
          className="rounded-[var(--radius-panel)] border border-negative/60 bg-surface p-4 text-sm text-negative"
        >
          {MESSAGES[error] ?? 'That could not be saved.'}
        </p>
      )}

      {/*
        A plain form posting to a Server Action: no JavaScript needed to change
        the shop's own details, same as every other mutation in this app.
      */}
      <form action={saveSettings} className="flex flex-col gap-8">
        <fieldset className="flex flex-col gap-5 border-0 p-0">
          <legend className="pb-1 text-lg font-semibold text-ink">What customers see</legend>

          <Field
            id="name"
            label="Shop name"
            hint="Shown on the storefront."
            invalid={error === 'name'}
          >
            <input
              id="name"
              name="name"
              required
              maxLength={120}
              defaultValue={value('name')}
              aria-invalid={error === 'name'}
              aria-describedby="name-hint"
              className={input}
            />
          </Field>

          <Field
            id="contactPhone"
            label="Contact phone"
            hint="Stored as +961…, however it is typed. This is the number customers call."
            invalid={error === 'phone'}
          >
            <input
              id="contactPhone"
              name="contactPhone"
              required
              type="tel"
              inputMode="tel"
              defaultValue={value('contactPhone')}
              aria-invalid={error === 'phone'}
              aria-describedby="contactPhone-hint"
              className={input}
            />
          </Field>

          <Field
            id="commercialRegistryNumber"
            label="Commercial registry number"
            // Law 81/2018 Art. 31 — and the reason a blank field is a real state
            // rather than an omission, so the label says so instead of "optional".
            hint="Required on the storefront once the business is registered. Leave blank until it is."
            invalid={false}
          >
            <input
              id="commercialRegistryNumber"
              name="commercialRegistryNumber"
              maxLength={60}
              defaultValue={value('commercialRegistryNumber')}
              aria-describedby="commercialRegistryNumber-hint"
              className={input}
            />
          </Field>
        </fieldset>

        <fieldset className="flex flex-col gap-5 border-0 p-0">
          <legend className="pb-1 text-lg font-semibold text-ink">Money</legend>

          <Field
            id="vatPercent"
            label="VAT rate (%)"
            hint="Prices already include VAT. This is the rate the storefront quotes — 11 is Lebanon's."
            invalid={error === 'vat'}
          >
            <input
              id="vatPercent"
              name="vatPercent"
              required
              inputMode="decimal"
              defaultValue={value('vatPercent')}
              aria-invalid={error === 'vat'}
              aria-describedby="vatPercent-hint"
              className={input}
            />
          </Field>

          <Field
            id="deliveryFee"
            label="Delivery fee (USD)"
            hint="Flat, on every order. Zero is free delivery. Orders already placed keep the fee they were quoted."
            invalid={error === 'fee'}
          >
            <input
              id="deliveryFee"
              name="deliveryFee"
              required
              inputMode="decimal"
              defaultValue={value('deliveryFee')}
              aria-invalid={error === 'fee'}
              aria-describedby="deliveryFee-hint"
              className={input}
            />
          </Field>
        </fieldset>

        <button
          type="submit"
          className="self-start rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-void transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Save settings
        </button>
      </form>

      {/*
        Shown, but not offered as a box to type in.
        A field that accepts an edit and changes nothing is worse than no field:
        the operator believes they have changed something, and nobody finds out
        until a customer does.
      */}
      <section
        aria-labelledby="deploy-heading"
        className="flex flex-col gap-4 rounded-[var(--radius-panel)] border border-hairline bg-surface p-5"
      >
        <div className="flex flex-col gap-1">
          <h2 id="deploy-heading" className="text-lg font-semibold text-ink">
            Set by the deploy
          </h2>
          <p className="text-sm text-muted">
            These are not editable here. Changing one is a deploy, not a form.
          </p>
        </div>

        <dl className="flex flex-col gap-3 text-sm">
          <Readonly label="Store" hint="STORE_ID">
            {container.config.storeId}
          </Readonly>
          <Readonly label="Site address" hint="SITE_URL — every canonical link is built from it">
            {container.config.siteUrl}
          </Readonly>
          <Readonly label="Languages" hint="Compiled in: the URL of every page starts with one">
            {LOCALES.join(' · ')}
          </Readonly>
        </dl>
      </section>
    </main>
  );
}

const Header = ({ importer }: { importer: boolean }) => (
  <header className="flex flex-wrap items-start justify-between gap-4">
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Settings</h1>
      <p className="text-sm text-muted">The shop's own details, and what delivery costs.</p>
    </div>

    <AdminNav current="/admin/settings" importer={importer} />
  </header>
);

const Field = ({
  id,
  label,
  hint,
  invalid,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  invalid: boolean;
  children: React.ReactNode;
}) => (
  <div className="flex flex-col gap-1.5">
    <label htmlFor={id} className="text-sm text-muted">
      {label}
    </label>
    {children}
    <p id={`${id}-hint`} className={`text-xs ${invalid ? 'text-negative' : 'text-faint'}`}>
      {hint}
    </p>
  </div>
);

const Readonly = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-muted">{label}</dt>
    <dd className="font-mono text-ink">{children}</dd>
    <dd className="text-xs text-faint">{hint}</dd>
  </div>
);
