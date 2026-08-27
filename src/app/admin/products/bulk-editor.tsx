'use client';

import type { BulkEditReport, BulkProductView, BulkRefusal, ProductStatus } from '@modules/catalog';
import { format as formatMoney } from '@platform/money';
import { useId, useState, useTransition } from 'react';
import { describeProductError } from '../import/problem-text';
import { applyBulkEdit, type BulkResponse, previewBulkEdit } from './actions';

/**
 * Select products, choose a change, look at what it would do, apply it.
 *
 * THE SELECTION IS A LIST OF IDS, NOT A FILTER
 * --------------------------------------------
 * "Apply to all 412 results" is one mistyped filter away from repricing the
 * catalogue, and what the operator would have approved is a COUNT rather than a
 * list. Everything here posts the exact ids that are checked on screen, which
 * also means the preview can show every affected product rather than a summary
 * of them.
 *
 * Every import from the catalogue barrel is type-only — a value import pulls the
 * module's infrastructure ring into the browser bundle and the build fails on
 * node:zlib. The status list arrives as a prop for that reason.
 */

export type ProductRow = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: string;
  readonly brand: string | null;
  readonly priceFromCents: number;
  readonly priceToCents: number;
  readonly variantCount: number;
  readonly onOfferVariants: number;
};

const cell = 'px-3 py-2 text-start align-top';
const headCell = `${cell} font-medium text-faint`;
const panel = 'rounded-panel border border-hairline bg-surface p-5';
const control =
  'rounded-lg border border-hairline bg-raised px-3 py-2 text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60';
const field = 'flex flex-col gap-1.5 text-sm text-muted';

const money = (cents: number) => formatMoney({ cents, currency: 'USD' }, 'en');

const priceLabel = (from: number, to: number): string =>
  from === to ? money(from) : `${money(from)} – ${money(to)}`;

const statusTone: Record<string, string> = {
  active: 'bg-positive/15 text-positive',
  draft: 'bg-caution/15 text-caution',
  archived: 'bg-hairline text-muted',
};

const StatusChip = ({ status }: { status: string }) => (
  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusTone[status] ?? ''}`}>
    {status}
  </span>
);

const describeRefusal = (reason: BulkRefusal): string =>
  reason.tag === 'price_unrepresentable'
    ? `The new price for ${reason.sku} would be too large to store exactly.`
    : describeProductError(reason.reason);

/** What changed between two views of the same product, in words. */
const differences = (before: BulkProductView, after: BulkProductView): string[] => {
  const parts: string[] = [];
  if (before.status !== after.status) parts.push(`${before.status} → ${after.status}`);
  if (before.brand !== after.brand) {
    parts.push(`${before.brand ?? 'no brand'} → ${after.brand ?? 'no brand'}`);
  }
  if (
    before.priceFromCents !== after.priceFromCents ||
    before.priceToCents !== after.priceToCents
  ) {
    parts.push(
      `${priceLabel(before.priceFromCents, before.priceToCents)} → ${priceLabel(after.priceFromCents, after.priceToCents)}`,
    );
  }
  if (before.onOfferVariants !== after.onOfferVariants) {
    parts.push(`${before.onOfferVariants} offers → ${after.onOfferVariants}`);
  }
  return parts;
};

const Changes = ({ report }: { report: BulkEditReport }) => {
  if (report.changes.length === 0) return null;

  return (
    <section className={`${panel} flex flex-col gap-4`} aria-labelledby="changes-heading">
      <h2 id="changes-heading" className="text-lg font-semibold text-ink">
        {report.committed ? 'Changed' : 'What will change'} ({report.changes.length})
      </h2>

      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable */}
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="w-full min-w-120 border-collapse text-sm">
          <caption className="sr-only">Products this change affects</caption>
          <thead>
            <tr className="border-hairline border-b">
              <th scope="col" className={headCell}>
                Product
              </th>
              <th scope="col" className={headCell}>
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {report.changes.map((change) => (
              <tr key={change.before.id} className="border-hairline/60 border-b last:border-b-0">
                <th scope="row" className={`${cell} font-normal text-ink`}>
                  {change.before.title}
                  <span className="block text-xs text-faint">{change.before.slug}</span>
                </th>
                <td className={`${cell} tabular-nums text-ink`}>
                  {differences(change.before, change.after).join(' · ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const Skipped = ({ report }: { report: BulkEditReport }) => {
  const total = report.unchanged.length + report.refusals.length + report.missing.length;
  if (total === 0) return null;

  return (
    <section className={`${panel} flex flex-col gap-3`} aria-labelledby="skipped-heading">
      <h2 id="skipped-heading" className="text-lg font-semibold text-caution">
        Not changed ({total})
      </h2>

      {report.unchanged.length > 0 && (
        <p className="text-sm text-muted">
          {report.unchanged.length} already {report.committed ? 'had' : 'have'} that value, so
          nothing is written for {report.unchanged.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      {report.refusals.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm">
          {report.refusals.map((refusal) => (
            <li key={refusal.product.id} className="text-ink">
              <span className="font-medium">{refusal.product.title}</span>
              <span className="block text-muted">{describeRefusal(refusal.reason)}</span>
            </li>
          ))}
        </ul>
      )}

      {report.missing.length > 0 && (
        <p className="text-sm text-negative">
          {report.missing.length} selected product{report.missing.length === 1 ? '' : 's'} no longer
          exist{report.missing.length === 1 ? 's' : ''}. Reload the page.
        </p>
      )}
    </section>
  );
};

const Receipt = ({ report }: { report: BulkEditReport }) => {
  if (!report.committed) return null;

  return (
    <div role="status" className={`${panel} border-positive/60 flex flex-col gap-1 text-positive`}>
      <p className="font-medium">
        Updated {report.written} product{report.written === 1 ? '' : 's'}.
      </p>
      {report.failures.length > 0 && (
        <ul className="list-disc ps-5 text-negative">
          {report.failures.map((failure) => (
            <li key={failure.slug}>
              {failure.slug} — {failure.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

type OperationKind = 'set_status' | 'set_brand' | 'scale_price' | 'clear_offer';

const OPERATIONS: readonly { readonly value: OperationKind; readonly label: string }[] = [
  { value: 'set_status', label: 'Set status' },
  { value: 'set_brand', label: 'Set brand' },
  { value: 'scale_price', label: 'Change price by %' },
  { value: 'clear_offer', label: 'Clear offers' },
];

/**
 * The one input that belongs to the chosen operation.
 *
 * Split out because the three branches together pushed BulkEditor past the
 * complexity limit, and because "which control does this operation need?" is a
 * question with an answer of its own.
 */
const OperationValue = ({
  id,
  operation,
  statuses,
  status,
  brand,
  percent,
  percentIsValid,
  disabled,
  onStatus,
  onBrand,
  onPercent,
  onAnyChange,
}: {
  id: string;
  operation: OperationKind;
  statuses: readonly ProductStatus[];
  status: string;
  brand: string;
  percent: string;
  percentIsValid: boolean;
  disabled: boolean;
  onStatus: (value: string) => void;
  onBrand: (value: string) => void;
  onPercent: (value: string) => void;
  onAnyChange: () => void;
}) => {
  if (operation === 'clear_offer') return null;

  if (operation === 'set_status') {
    return (
      <div className={field}>
        {/*
          The label is a SIBLING of the select, not its parent. A <label> that
          wraps a <select> has every option folded into its accessible name —
          this control announced itself as "To draft active archived" — which is
          both wrong for a screen reader and unfindable by name.
        */}
        <label htmlFor={id}>To</label>
        <select
          id={id}
          value={status}
          disabled={disabled}
          onChange={(event) => {
            onStatus(event.target.value);
            onAnyChange();
          }}
          className={control}
        >
          {statuses.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (operation === 'set_brand') {
    return (
      <div className={field}>
        <label htmlFor={id}>To</label>
        <input
          id={id}
          type="text"
          value={brand}
          disabled={disabled}
          placeholder="Leave empty to clear"
          onChange={(event) => {
            onBrand(event.target.value);
            onAnyChange();
          }}
          className={`${control} w-56`}
        />
      </div>
    );
  }

  return (
    <div className={field}>
      <label htmlFor={id}>Percent</label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step="0.01"
        value={percent}
        disabled={disabled}
        aria-invalid={!percentIsValid}
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          onPercent(event.target.value);
          onAnyChange();
        }}
        className={`${control} w-32`}
      />
    </div>
  );
};

const ProductTable = ({
  rows,
  pageSize,
  selected,
  disabled,
  allSelected,
  onToggle,
  onToggleAll,
}: {
  rows: readonly ProductRow[];
  pageSize: number;
  selected: ReadonlySet<string>;
  disabled: boolean;
  allSelected: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}) => (
  <section className={`${panel} flex flex-col gap-4`} aria-labelledby="products-heading">
    <h2 id="products-heading" className="text-lg font-semibold text-ink">
      {rows.length} product{rows.length === 1 ? '' : 's'}
      {rows.length === pageSize && <span className="text-sm text-faint"> (first page)</span>}
    </h2>

    {rows.length === 0 ? (
      <p className="text-sm text-muted">Nothing matches that filter.</p>
    ) : (
      // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="w-full min-w-160 border-collapse text-sm">
          <caption className="sr-only">Products, with a checkbox to select each</caption>
          <thead>
            <tr className="border-hairline border-b">
              <th scope="col" className={headCell}>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    disabled={disabled}
                    onChange={onToggleAll}
                    className="size-4 accent-accent"
                  />
                  <span className="sr-only">Select every product on this page</span>
                </label>
              </th>
              <th scope="col" className={headCell}>
                Product
              </th>
              <th scope="col" className={headCell}>
                Status
              </th>
              <th scope="col" className={headCell}>
                Brand
              </th>
              <th scope="col" className={headCell}>
                Price
              </th>
              <th scope="col" className={headCell}>
                Variants
              </th>
              <th scope="col" className={headCell}>
                On offer
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={`border-hairline/60 border-b last:border-b-0 ${
                  selected.has(row.id) ? 'bg-raised' : ''
                }`}
              >
                <td className={cell}>
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    disabled={disabled}
                    onChange={() => onToggle(row.id)}
                    // The row header is the product title, but a checkbox
                    // read on its own needs to say which product it selects.
                    aria-label={`Select ${row.title}`}
                    className="size-4 accent-accent"
                  />
                </td>
                <th scope="row" className={`${cell} font-normal text-ink`}>
                  {row.title}
                  <span className="block text-xs text-faint">{row.slug}</span>
                </th>
                <td className={cell}>
                  <StatusChip status={row.status} />
                </td>
                <td className={`${cell} text-muted`}>{row.brand ?? '—'}</td>
                <td className={`${cell} tabular-nums text-ink`}>
                  {priceLabel(row.priceFromCents, row.priceToCents)}
                </td>
                <td className={`${cell} tabular-nums text-muted`}>{row.variantCount}</td>
                <td className={`${cell} tabular-nums text-muted`}>
                  {row.onOfferVariants === 0 ? '—' : row.onOfferVariants}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </section>
);

export const BulkEditor = ({
  rows,
  statuses,
  pageSize,
}: {
  rows: readonly ProductRow[];
  statuses: readonly ProductStatus[];
  pageSize: number;
}) => {
  const operationId = useId();
  const valueId = useId();

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [operation, setOperation] = useState<OperationKind>('set_status');
  const [status, setStatus] = useState<string>(statuses[0] ?? 'draft');
  const [brand, setBrand] = useState('');
  const [percent, setPercent] = useState('5');
  const [report, setReport] = useState<BulkEditReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (id: string) => {
    setReport(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allOnPageSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  const toggleAll = () => {
    setReport(null);
    setSelected(allOnPageSelected ? new Set() : new Set(rows.map((row) => row.id)));
  };

  const formData = (): FormData => {
    const data = new FormData();
    for (const id of selected) data.append('productId', id);
    data.set('operation', operation);
    if (operation === 'set_status') data.set('status', status);
    if (operation === 'set_brand') data.set('brand', brand);
    if (operation === 'scale_price') {
      /*
       * "+5" becomes 10500 basis points HERE, once.
       *
       * Math.round is on the percentage, not the price: 12.5% is 11250 exactly,
       * and a percentage with more decimals than that is refused by the server
       * rather than quietly rounded into a different price change.
       */
      data.set('basisPoints', String(Math.round((100 + Number(percent)) * 100)));
    }
    return data;
  };

  const send = (commit: boolean) => {
    if (selected.size === 0) {
      setError('Select at least one product.');
      return;
    }

    const data = formData();
    startTransition(async () => {
      const response: BulkResponse = commit
        ? await applyBulkEdit(data)
        : await previewBulkEdit(data);

      if (response.ok) {
        setError(null);
        setReport(response.report);
        // After a commit the rows on screen are stale — the operator reloads to
        // see the new state, and the selection must not survive into a second
        // apply against products that have already been changed.
        if (response.report.committed) setSelected(new Set());
      } else {
        setError(response.message);
      }
    });
  };

  const percentIsValid =
    percent.trim().length > 0 && Number.isFinite(Number(percent)) && Number(percent) > -100;

  const canPreview = selected.size > 0 && (operation !== 'scale_price' || percentIsValid);

  return (
    <div className="flex flex-col gap-6" aria-busy={pending}>
      <section className={`${panel} flex flex-wrap items-end gap-3`} aria-label="Apply a change">
        <div className={field}>
          <label htmlFor={operationId}>Change</label>
          <select
            id={operationId}
            value={operation}
            disabled={pending}
            onChange={(event) => {
              setOperation(event.target.value as OperationKind);
              setReport(null);
            }}
            className={control}
          >
            {OPERATIONS.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>

        <OperationValue
          id={valueId}
          operation={operation}
          statuses={statuses}
          status={status}
          brand={brand}
          percent={percent}
          percentIsValid={percentIsValid}
          disabled={pending}
          onStatus={setStatus}
          onBrand={setBrand}
          onPercent={setPercent}
          onAnyChange={() => setReport(null)}
        />

        <button
          type="button"
          onClick={() => send(false)}
          disabled={pending || !canPreview}
          className="rounded-lg border border-hairline px-4 py-2 text-sm text-ink hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Working…' : `Check ${selected.size} selected`}
        </button>

        {operation === 'scale_price' && (
          <p id={`${valueId}-hint`} className="w-full text-sm text-faint">
            Positive raises, negative lowers. Was-prices are left where they are, so an offer whose
            discount would vanish is reported rather than published.
          </p>
        )}
      </section>

      <p aria-live="polite" className="sr-only">
        {pending
          ? 'Checking the selected products'
          : report === null
            ? `${selected.size} products selected`
            : `${report.changes.length} products would change`}
      </p>

      {error !== null && (
        <p role="alert" className={`${panel} border-negative/60 text-negative`}>
          {error}
        </p>
      )}

      {report !== null && (
        <>
          <Receipt report={report} />
          <Changes report={report} />
          <Skipped report={report} />

          {!report.committed && report.changes.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => send(true)}
                disabled={pending}
                className="rounded-lg bg-accent px-4 py-2.5 font-medium text-void transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
              >
                Apply to {report.changes.length} product{report.changes.length === 1 ? '' : 's'}
              </button>
            </div>
          )}
        </>
      )}

      <ProductTable
        rows={rows}
        pageSize={pageSize}
        selected={selected}
        disabled={pending}
        allSelected={allOnPageSelected}
        onToggle={toggle}
        onToggleAll={toggleAll}
      />
    </div>
  );
};
