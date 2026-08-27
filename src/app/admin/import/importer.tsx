'use client';

import type { ColumnMapping, ImportField, ImportReport } from '@modules/catalog';
import { format as formatMoney } from '@platform/money';
import { useId, useState, useTransition } from 'react';
import { analyseImport, commitImport, type ImportResponse } from './actions';
import { describeCellProblem, describeProductError, FIELD_LABELS } from './problem-text';

/**
 * The import screen.
 *
 * THE FILE STAYS IN THE BROWSER
 * -----------------------------
 * Analysing and committing are two round trips, and the file is uploaded on
 * both. The alternative — parking it in a temp directory or a session store
 * between the two — would need somewhere to put it, an expiry, and a cleanup
 * job, and would break the moment a second instance served the second request.
 * Re-uploading a few hundred kilobytes costs a second and nothing else.
 *
 * It also means the commit re-reads the CURRENT catalogue, so a product created
 * by someone else between preview and commit is correctly seen as an update.
 * That is the right behaviour and it is why the numbers are compared afterwards
 * rather than assumed: if what happened differs from what was approved, the
 * operator is told, instead of finding out from the storefront.
 *
 * WHY THE FIELD LIST ARRIVES AS A PROP
 * ------------------------------------
 * Every import from @modules/catalog here is type-only, and that is not a style
 * choice. A VALUE import from the barrel pulls the whole module in behind it —
 * including the infrastructure ring, which reaches read-excel-file and node:zlib
 * — and the browser build fails outright on the unresolvable Node built-ins. It
 * failed exactly that way when IMPORT_FIELDS was imported here directly.
 *
 * So the server page reads the domain's vocabulary and hands it down. The client
 * knows nothing the server did not give it, which is the correct direction
 * anyway.
 */

const cell = 'px-3 py-2 text-start align-top';
const headCell = `${cell} font-medium text-faint`;
const panel = 'rounded-panel border border-hairline bg-surface p-5';

const money = (cents: number, currency: 'USD') => formatMoney({ cents, currency }, 'en');

const priceLabel = (from: number, to: number, currency: 'USD'): string =>
  from === to ? money(from, currency) : `${money(from, currency)} – ${money(to, currency)}`;

const Summary = ({ report }: { report: ImportReport }) => {
  const items: [string, number][] = [
    ['Rows of data', report.summary.dataRows],
    ['Products', report.summary.products],
    ['To create', report.summary.toCreate],
    ['To update', report.summary.toUpdate],
    ['Rows rejected', report.summary.rowsRejected],
  ];

  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {items.map(([label, value]) => (
        <div key={label} className={`${panel} flex flex-col gap-1`}>
          <dt className="text-xs uppercase tracking-wide text-faint">{label}</dt>
          <dd
            className={`text-2xl font-semibold tabular-nums ${
              label === 'Rows rejected' && value > 0 ? 'text-caution' : 'text-ink'
            }`}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
};

const MappingEditor = ({
  report,
  fields,
  requiredFields,
  disabled,
  onChange,
}: {
  report: ImportReport;
  fields: readonly ImportField[];
  requiredFields: readonly ImportField[];
  disabled: boolean;
  onChange: (field: ImportField, column: number | null) => void;
}) => (
  <section className={`${panel} flex flex-col gap-4`} aria-labelledby="mapping-heading">
    <div className="flex flex-col gap-1">
      <h2 id="mapping-heading" className="text-lg font-semibold text-ink">
        Columns
      </h2>
      <p className="text-sm text-muted">
        Detected from the header row. Check the required fields before importing — a wrongly-mapped
        price column is the one mistake this screen exists to catch.
      </p>
    </div>

    {/*
      A container that scrolls horizontally is unreachable by keyboard unless it
      is focusable. axe reports it as a SERIOUS violation, and on a phone these
      tables genuinely do overflow — this is a real keyboard trap, not a
      technicality.

      Biome's rule says the opposite: no tabindex on a non-interactive element.
      Between a linter's heuristic and a keyboard user who cannot read the table,
      the keyboard user wins.
    */}
    {/* biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable */}
    <div className="overflow-x-auto" tabIndex={0}>
      <table className="w-full min-w-140 border-collapse text-sm">
        <caption className="sr-only">Product fields and the spreadsheet column each reads</caption>
        <thead>
          <tr className="border-hairline border-b">
            <th scope="col" className={headCell}>
              Field
            </th>
            <th scope="col" className={headCell}>
              Spreadsheet column
            </th>
            <th scope="col" className={headCell}>
              First values
            </th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => {
            const column = report.mapping[field];
            const required = requiredFields.includes(field);
            const missing = required && column === undefined;

            return (
              <tr key={field} className="border-hairline/60 border-b last:border-b-0">
                <th scope="row" className={`${cell} font-normal text-ink`}>
                  {FIELD_LABELS[field]}
                  {required && (
                    <>
                      {/* The asterisk is decoration; the word is what a screen
                          reader should hear, and aria-label does not apply to a
                          plain span. */}
                      <span className="text-negative" aria-hidden="true">
                        {' '}
                        *
                      </span>
                      <span className="sr-only"> (required)</span>
                    </>
                  )}
                </th>
                <td className={cell}>
                  <select
                    // The field label is already the row header, but a screen
                    // reader reading the control alone needs it too.
                    aria-label={`Column for ${FIELD_LABELS[field]}`}
                    aria-invalid={missing}
                    disabled={disabled}
                    value={column === undefined ? '' : String(column)}
                    onChange={(event) =>
                      onChange(field, event.target.value === '' ? null : Number(event.target.value))
                    }
                    className={`w-full rounded-lg border bg-raised px-2 py-1.5 text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 ${
                      missing ? 'border-negative' : 'border-hairline'
                    }`}
                  >
                    <option value="">— not imported —</option>
                    {report.headers.map((header, index) => (
                      // Index is the identity here: two columns may share a
                      // heading, and they are still different columns.
                      // biome-ignore lint/suspicious/noArrayIndexKey: the index IS the value
                      <option key={`${header}-${index}`} value={index}>
                        {header.trim() === '' ? `(column ${index + 1})` : header}
                      </option>
                    ))}
                  </select>
                </td>
                <td className={`${cell} text-faint`}>
                  {column === undefined
                    ? '—'
                    : report.sampleRows
                        .map((row) => row[column])
                        .filter((value) => value !== undefined && value.trim() !== '')
                        .slice(0, 3)
                        .join(' · ') || '(empty)'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </section>
);

const problemCount = (report: ImportReport): number =>
  report.rowProblems.length + report.productProblems.length + report.skuConflicts.length;

const Problems = ({ report }: { report: ImportReport }) => {
  if (problemCount(report) === 0) return null;

  return (
    <section className={`${panel} flex flex-col gap-4`} aria-labelledby="problems-heading">
      <div className="flex flex-col gap-1">
        <h2 id="problems-heading" className="text-lg font-semibold text-caution">
          Rows that will be skipped ({problemCount(report)})
        </h2>
        <p className="text-sm text-muted">
          Everything else still imports. Fix these rows in the sheet and import again — re-importing
          updates rather than duplicates.
        </p>
      </div>

      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable */}
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="w-full min-w-120 border-collapse text-sm">
          <caption className="sr-only">Problems found, by spreadsheet row</caption>
          <thead>
            <tr className="border-hairline border-b">
              <th scope="col" className={headCell}>
                Row
              </th>
              <th scope="col" className={headCell}>
                Field
              </th>
              <th scope="col" className={headCell}>
                Problem
              </th>
            </tr>
          </thead>
          <tbody>
            {report.rowProblems.map((problem) => (
              <tr
                key={`${problem.row}-${problem.field}-${problem.problem.tag}`}
                className="border-hairline/60 border-b last:border-b-0"
              >
                <th scope="row" className={`${cell} font-normal tabular-nums text-ink`}>
                  {problem.row}
                </th>
                <td className={`${cell} text-muted`}>{FIELD_LABELS[problem.field]}</td>
                <td className={`${cell} text-ink`}>{describeCellProblem(problem.problem)}</td>
              </tr>
            ))}
            {report.productProblems.map((problem) => (
              <tr
                key={`${problem.slug}-${problem.reason.tag}`}
                className="border-hairline/60 border-b last:border-b-0"
              >
                <th scope="row" className={`${cell} font-normal tabular-nums text-ink`}>
                  {problem.rows.join(', ')}
                </th>
                <td className={`${cell} text-muted`}>{problem.slug}</td>
                <td className={`${cell} text-ink`}>{describeProductError(problem.reason)}</td>
              </tr>
            ))}
            {report.skuConflicts.map((conflict) => (
              <tr
                key={`${conflict.slug}-${conflict.sku}`}
                className="border-hairline/60 border-b last:border-b-0"
              >
                <th scope="row" className={`${cell} font-normal tabular-nums text-ink`}>
                  {conflict.rows.join(', ')}
                </th>
                <td className={`${cell} text-muted`}>SKU</td>
                <td className={`${cell} text-ink`}>
                  The SKU {conflict.sku} already belongs to “{conflict.ownedBySlug}”. Change the
                  SKU, or edit that product first — a SKU identifies one product across the whole
                  store.
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const Preview = ({ report }: { report: ImportReport }) => {
  if (report.products.length === 0) return null;

  return (
    <section className={`${panel} flex flex-col gap-4`} aria-labelledby="preview-heading">
      <h2 id="preview-heading" className="text-lg font-semibold text-ink">
        {report.committed ? 'Imported' : 'What will be imported'}
      </h2>

      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable */}
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="w-full min-w-160 border-collapse text-sm">
          <caption className="sr-only">Products in this import</caption>
          <thead>
            <tr className="border-hairline border-b">
              <th scope="col" className={headCell}>
                Product
              </th>
              <th scope="col" className={headCell}>
                Action
              </th>
              <th scope="col" className={headCell}>
                Brand
              </th>
              <th scope="col" className={headCell}>
                Status
              </th>
              <th scope="col" className={headCell}>
                Variants
              </th>
              <th scope="col" className={headCell}>
                Price
              </th>
              <th scope="col" className={headCell}>
                Stock
              </th>
              <th scope="col" className={headCell}>
                Languages
              </th>
              <th scope="col" className={headCell}>
                Rows
              </th>
            </tr>
          </thead>
          <tbody>
            {report.products.map((product) => (
              <tr key={product.slug} className="border-hairline/60 border-b last:border-b-0">
                <th scope="row" className={`${cell} font-normal text-ink`}>
                  {product.title}
                  <span className="block text-xs text-faint">{product.slug}</span>
                </th>
                <td className={cell}>
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                      product.action === 'create'
                        ? 'bg-positive/15 text-positive'
                        : 'bg-accent/15 text-accent'
                    }`}
                  >
                    {product.action === 'create' ? 'new' : 'update'}
                  </span>
                </td>
                <td className={`${cell} text-muted`}>{product.brand ?? '—'}</td>
                <td className={`${cell} text-muted`}>{product.status}</td>
                <td className={`${cell} tabular-nums text-muted`}>{product.variantCount}</td>
                <td className={`${cell} tabular-nums text-ink`}>
                  {priceLabel(product.priceFromCents, product.priceToCents, product.currency)}
                </td>
                <td className={`${cell} tabular-nums text-muted`}>
                  {/*
                    An em dash, not a zero. A sheet that says nothing about stock
                    leaves the SKU uncounted — which stays on sale — and printing
                    0 here would read as sold out.
                  */}
                  {product.stock.length === 0
                    ? '—'
                    : product.stock.map((level) => `${level.sku}: ${level.onHand}`).join(', ')}
                </td>
                <td className={`${cell} text-muted`}>
                  {product.translatedInto.join(', ')}
                  {product.translatedInto.length === 1 && (
                    <span className="block text-xs text-faint">needs ar, fr</span>
                  )}
                </td>
                <td className={`${cell} tabular-nums text-faint`}>{product.rows.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

/** Whether what was written differs from the summary the operator approved. */
const divergedFrom = (
  approved: ImportReport['summary'] | null,
  report: ImportReport | null,
): boolean =>
  report?.committed === true &&
  approved !== null &&
  (approved.toCreate !== report.summary.toCreate ||
    approved.toUpdate !== report.summary.toUpdate ||
    approved.products !== report.summary.products);

const Receipt = ({ report, diverged }: { report: ImportReport; diverged: boolean }) => {
  if (!report.committed) return null;

  return (
    <div role="status" className={`${panel} border-positive/60 flex flex-col gap-1 text-positive`}>
      <p className="font-medium">
        Imported {report.written} product{report.written === 1 ? '' : 's'}
        {report.stockWritten > 0 && `, and set stock on ${report.stockWritten} SKUs`}.
      </p>
      {report.stockFailures.length > 0 && (
        <ul className="list-disc ps-5 text-negative">
          {report.stockFailures.map((failure) => (
            <li key={failure.sku}>
              stock for {failure.sku} — {failure.reason}
            </li>
          ))}
        </ul>
      )}
      {diverged && (
        <p className="text-caution">
          What was written differs from the preview you approved — the catalogue changed in between.
          Review the table below.
        </p>
      )}
      {report.failures.length > 0 && (
        <div className="flex flex-col gap-1 text-negative">
          <p className="font-medium">
            {report.failures.length} product{report.failures.length === 1 ? '' : 's'} could not be
            written:
          </p>
          <ul className="list-disc ps-5">
            {report.failures.map((failure) => (
              <li key={failure.slug}>
                {failure.slug} — {failure.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const MissingFields = ({ report }: { report: ImportReport }) => {
  if (report.mappingProblems.length === 0) return null;

  return (
    <p role="alert" className={`${panel} border-negative/60 text-negative`}>
      Map a column to{' '}
      {report.mappingProblems.map((problem) => FIELD_LABELS[problem.field]).join(', ')} before
      importing.
    </p>
  );
};

export type ImporterProps = {
  /** Every mappable field, in the order the editor lists them. */
  readonly fields: readonly ImportField[];
  /** The subset without which a row cannot become a product. */
  readonly requiredFields: readonly ImportField[];
};

export const Importer = ({ fields, requiredFields }: ImporterProps) => {
  const fileInputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<ImportReport['summary'] | null>(null);
  const [pending, startTransition] = useTransition();

  const apply = (response: ImportResponse) => {
    if (response.ok) {
      setError(null);
      setReport(response.report);
      return;
    }
    setError(response.message);
  };

  const send = (chosen: File, mapping: ColumnMapping | null, commit: boolean) => {
    const data = new FormData();
    data.set('file', chosen);
    if (mapping !== null) data.set('mapping', JSON.stringify(mapping));

    startTransition(async () => {
      apply(commit ? await commitImport(data) : await analyseImport(data));
    });
  };

  const chooseFile = (chosen: File | null) => {
    setFile(chosen);
    setReport(null);
    setApproved(null);
    setError(null);
    if (chosen !== null) send(chosen, null, false);
  };

  const changeMapping = (field: ImportField, column: number | null) => {
    if (file === null || report === null) return;

    const next: ColumnMapping = { ...report.mapping };
    if (column === null) delete next[field];
    else next[field] = column;

    // Re-analysed rather than adjusted in place: the preview must always be the
    // output of the real planner under the real mapping, never a client-side
    // approximation of what the planner would say.
    send(file, next, false);
  };

  const runImport = () => {
    if (file === null || report === null) return;
    setApproved(report.summary);
    send(file, report.mapping, true);
  };

  const blocked = report !== null && report.mappingProblems.length > 0;
  const nothingToDo = report !== null && report.products.length === 0;

  return (
    <div className="flex flex-col gap-6" aria-busy={pending}>
      <section className={`${panel} flex flex-col gap-3`}>
        <label htmlFor={fileInputId} className="text-sm font-medium text-ink">
          Catalogue spreadsheet (.xlsx)
        </label>
        <input
          id={fileInputId}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={pending}
          onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
          className="text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-raised file:px-3 file:py-2 file:text-ink hover:file:bg-hairline"
        />
        <p className="text-sm text-faint">
          One row per variant. Nothing is written until you press Import.
        </p>
      </section>

      {/*
        polite, not assertive: these updates arrive while the operator is reading
        the table, and interrupting them mid-sentence to say "analysed" helps
        nobody. The error below is assertive because it stops the workflow.
      */}
      <p aria-live="polite" className="sr-only">
        {pending
          ? 'Reading the spreadsheet'
          : report === null
            ? ''
            : `${report.summary.products} products found, ${report.summary.rowsRejected} rows rejected`}
      </p>

      {error !== null && (
        <p role="alert" className={`${panel} border-negative/60 text-negative`}>
          {error}
        </p>
      )}

      {report !== null && (
        <>
          <Receipt report={report} diverged={divergedFrom(approved, report)} />
          <MissingFields report={report} />

          <Summary report={report} />
          <MappingEditor
            report={report}
            fields={fields}
            requiredFields={requiredFields}
            disabled={pending}
            onChange={changeMapping}
          />
          <Problems report={report} />
          <Preview report={report} />

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={runImport}
              disabled={pending || blocked || nothingToDo}
              className="rounded-lg bg-accent px-4 py-2.5 font-medium text-void transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending
                ? 'Working…'
                : `Import ${report.summary.products} product${report.summary.products === 1 ? '' : 's'}`}
            </button>
            {nothingToDo && !blocked && (
              <span className="text-sm text-muted">Nothing in this sheet can be imported yet.</span>
            )}
          </div>
        </>
      )}
    </div>
  );
};
