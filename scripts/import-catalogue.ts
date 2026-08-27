/**
 * Import a catalogue spreadsheet from the terminal.
 *
 *   pnpm import:catalogue catalogue.xlsx            # dry run, writes nothing
 *   pnpm import:catalogue catalogue.xlsx --commit   # applies it
 *
 * Named import:catalogue rather than import because `pnpm import` is a built-in
 * pnpm command (it imports a lockfile from npm or yarn) and shadows the script.
 *
 * The admin screen comes later; this exists so the importer is usable now rather
 * than sitting behind a UI that has not been built. It is also the honest way to
 * exercise the engine against a real file.
 */

import { readFileSync } from 'node:fs';
import { getContainer } from '../src/composition/index.js';
import type { ImportField, ImportPlan } from '../src/modules/catalog/index.js';
import { closeMongo } from '../src/platform/mongo/index.js';

/** One readable line per problem, with the Excel row so it can be found. */
const describeRowProblem = (
  row: number,
  field: ImportField,
  problem: { tag: string } & Record<string, unknown>,
): string => {
  const where = `row ${row}, ${field}`;
  switch (problem.tag) {
    case 'required_cell_empty':
      return `${where}: required, but empty`;
    case 'unparsable_money':
      return `${where}: "${String(problem.value)}" is not an amount — write it as 1299.00`;
    case 'ambiguous_date':
      return `${where}: "${String(problem.value)}" could be day/month or month/day — write it as 2026-12-01`;
    case 'unparsable_date':
      return `${where}: "${String(problem.value)}" is not a date — write it as 2026-12-01`;
    case 'unknown_status':
      return `${where}: "${String(problem.value)}" is not a status — use active, draft or archived`;
    case 'unparsable_number':
      return `${where}: "${String(problem.value)}" is not a whole number`;
    case 'duplicate_sku':
      return `${where}: this SKU is already used by row ${String(problem.firstSeenAtRow)}`;
    default:
      return `${where}: ${problem.tag}`;
  }
};

const report = (plan: ImportPlan): void => {
  const { summary } = plan;

  if (plan.mappingProblems.length > 0) {
    console.error('\nThe sheet is missing columns the importer needs:');
    for (const problem of plan.mappingProblems) console.error(`  - ${problem.field}`);
    console.error('\nNothing was read. Add the columns, or map them explicitly.\n');
    return;
  }

  console.warn(`\n  ${summary.dataRows} data rows -> ${summary.products} products`);
  console.warn(`  ${summary.toCreate} to create, ${summary.toUpdate} to update`);
  if (summary.rowsRejected > 0) console.warn(`  ${summary.rowsRejected} rows rejected`);

  if (plan.products.length > 0) {
    console.warn('\n  Products:');
    for (const planned of plan.products) {
      const variants = planned.product.variants.length;
      console.warn(
        `    ${planned.action.padEnd(6)} ${planned.product.slug}  (${variants} variant${variants === 1 ? '' : 's'}, rows ${planned.rows.join(', ')})`,
      );
    }
  }

  if (plan.rowProblems.length > 0) {
    console.error('\n  Rejected rows:');
    for (const problem of plan.rowProblems) {
      console.error(
        `    ${describeRowProblem(problem.row, problem.field, problem.problem as { tag: string } & Record<string, unknown>)}`,
      );
    }
  }

  if (plan.productProblems.length > 0) {
    console.error('\n  Rejected products:');
    for (const problem of plan.productProblems) {
      console.error(
        `    ${problem.slug} (rows ${problem.rows.join(', ')}): ${JSON.stringify(problem.reason)}`,
      );
    }
  }
};

const main = async (): Promise<void> => {
  const [, , path, ...flags] = process.argv;
  const commit = flags.includes('--commit');

  if (path === undefined) {
    console.error('Usage: pnpm import:catalogue <file.xlsx> [--commit]');
    process.exitCode = 1;
    return;
  }

  const container = await getContainer();
  await container.catalog.ensureIndexes();

  const result = await container.catalog.importProducts({
    file: new Uint8Array(readFileSync(path)),
    commit,
  });

  if (!result.ok) {
    console.error(`\nCould not read ${path}: ${JSON.stringify(result.error)}\n`);
    process.exitCode = 1;
    return;
  }

  console.warn(`\nColumns detected in ${path}:`);
  for (const [field, index] of Object.entries(result.value.mapping)) {
    console.warn(`  ${field.padEnd(16)} <- column ${index + 1} "${result.value.headers[index]}"`);
  }

  report(result.value.plan);

  if (commit) {
    console.warn(`\n  Wrote ${result.value.written} products.\n`);
  } else {
    console.warn('\n  DRY RUN — nothing was written. Re-run with --commit to apply.\n');
  }
};

main()
  .catch((error: unknown) => {
    console.error('Import failed:', error);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
