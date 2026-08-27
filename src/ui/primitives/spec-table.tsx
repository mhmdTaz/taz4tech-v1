import { Fragment } from 'react';

/**
 * The product spec table.
 *
 * A real <table> with row headers, not a grid of divs. Screen readers announce
 * "RAM: 8 GB" from the header association; a div grid announces two unrelated
 * strings. It is also what makes the table legible to the crawlers that surface
 * long-tail compatibility queries — the traffic that is actually reachable in
 * this vertical.
 */

export type SpecRow = {
  readonly name: string;
  readonly value: string;
  readonly group: string | null;
};

/** Rows in their given order, grouped, with ungrouped rows first. */
const grouped = (rows: readonly SpecRow[]): { group: string | null; rows: SpecRow[] }[] => {
  const groups: { group: string | null; rows: SpecRow[] }[] = [];
  for (const row of rows) {
    const existing = groups.find((candidate) => candidate.group === row.group);
    if (existing === undefined) groups.push({ group: row.group, rows: [row] });
    else existing.rows.push(row);
  }
  return groups.sort((a, b) => (a.group === null ? -1 : b.group === null ? 1 : 0));
};

export const SpecTable = ({
  rows,
  caption,
}: {
  rows: readonly SpecRow[];
  /** Translated caption, e.g. "Specifications". */
  caption: string;
}) => {
  if (rows.length === 0) return null;

  return (
    // Scrolls inside its own container so a long value cannot make the page
    // scroll sideways on a phone.
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="mb-4 text-start text-sm font-medium uppercase tracking-widest text-faint">
          {caption}
        </caption>
        <tbody>
          {grouped(rows).map(({ group, rows: groupRows }) => (
            <Fragment key={group ?? 'ungrouped'}>
              {group !== null && (
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={2}
                    className="pt-6 pb-2 text-start text-xs uppercase tracking-widest text-accent"
                  >
                    {group}
                  </th>
                </tr>
              )}
              {groupRows.map((row) => (
                <tr
                  key={`${group ?? 'ungrouped'}-${row.name}`}
                  className="border-b border-hairline"
                >
                  <th scope="row" className="w-2/5 py-3 pe-4 text-start font-normal text-muted">
                    {row.name}
                  </th>
                  <td className="py-3 text-ink">{row.value}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
};
