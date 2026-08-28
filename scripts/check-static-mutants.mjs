/**
 * Prove that the suite catches the mutants Stryker cannot test.
 *
 * WHY THIS EXISTS
 * ---------------
 * Stryker flips one mutant at a time by setting a global and re-running the
 * tests. That works for code inside a function, which re-executes on every
 * call — and does NOT work for code that runs once, at module load, to build a
 * constant. Vitest imports a module once per worker and caches it, so by the
 * time the switch is flipped the constant already exists, built from the
 * ORIGINAL expression. The mutated line never runs again, no test fails, and
 * Stryker reports "Survived".
 *
 * Stryker calls these STATIC mutants and marks them `static: true`. Most it
 * kills anyway; the ones it does not are reported as survivors, and some of
 * those are false alarms.
 *
 * The obvious fix — `ignoreStatic: true` — is worse than the problem. On
 * search.ts alone it drops 137 of 176 mutants, the whole synonym vocabulary and
 * every character table with it, and reports 100% for the 39 that are left. A
 * score that excludes the lookup tables is not a score.
 *
 * So this script does what Stryker cannot: it edits the file on disk, applies
 * one surviving static mutant for real, runs the whole unit suite, and requires
 * it to fail. Every static survivor is then either proven caught — a reporting
 * artifact, recorded as such — or a genuine hole that fails the run.
 *
 *   node scripts/check-static-mutants.mjs [path/to/mutation.json]
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/*
 * --all also replays the survivors Stryker DID have jurisdiction over. Not part
 * of the gate — it is how you tell a real gap from a reporting artifact without
 * reasoning your way to the wrong answer, which is easy: a mutant can look
 * obviously fatal and still survive because a later layer normalises it away.
 */
const ALL = process.argv.includes('--all');
const REPORT = process.argv.find((arg) => arg.endsWith('.json')) ?? 'stryker-report/mutation.json';

/** Statuses that mean "Stryker did not observe a test failure for this one". */
const UNPROVEN = new Set(['Survived', 'NoCoverage', 'Ignored']);

/**
 * Static mutants no test can ever kill, each with the reason it cannot.
 *
 * Kept short and argued. An entry here is a claim that the mutation changes
 * nothing observable — not that writing the test looked like work. The mutants
 * are still replayed: if one of these ever gets caught, the claim is wrong and
 * the run fails, which is how the list stays honest.
 */
const EQUIVALENT = [
  {
    file: 'src/modules/orders/domain/order.ts',
    replacement: '["Stryker was here"]',
    // Matched on file and replacement rather than on a line, which would drift
    // with every edit above it. `count` is what stops the exemption from
    // quietly spreading to a new array added to the same file later.
    count: 2,
    why: 'The transition table is searched with includes() against a real OrderStatus, and "Stryker was here" is not one. A mutation the type system forbids is not a gap in the tests.',
  },
];

const entryFor = (file, mutant) =>
  EQUIVALENT.find((entry) => entry.file === file && entry.replacement === mutant.replacement);

/**
 * Character offset of a 1-based line/column pair.
 *
 * The mutation-testing-elements schema counts both from 1, so both lose one.
 */
const offsetOf = (source, { line, column }) => {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = source.indexOf('\n', offset);
    if (next === -1) throw new Error(`Line ${line} is past the end of the file`);
    offset = next + 1;
  }
  return offset + (column - 1);
};

const applyMutant = (source, mutant) => {
  const start = offsetOf(source, mutant.location.start);
  const end = offsetOf(source, mutant.location.end);
  return source.slice(0, start) + mutant.replacement + source.slice(end);
};

const suitePasses = () => {
  // One string rather than an argv array: with shell: true the array form is
  // concatenated unescaped, which Node deprecated for exactly that reason.
  const run = spawnSync('npx vitest run --config vitest.mutation.config.ts', {
    shell: true,
    encoding: 'utf8',
  });
  // A non-zero exit is what we want: the suite noticed. A module that fails to
  // load counts too — the tests could not run because the code was broken.
  return run.status === 0;
};

const report = JSON.parse(readFileSync(REPORT, 'utf8'));

const pending = Object.entries(report.files)
  // A report produced with a hand-passed --mutate can include the test files
  // themselves. Mutating a test proves nothing, and there are hundreds of them.
  .filter(([file]) => !file.endsWith('.test.ts'))
  .flatMap(([file, data]) =>
    data.mutants
      .filter((mutant) => (ALL || mutant.static === true) && UNPROVEN.has(mutant.status))
      .map((mutant) => ({ file, mutant })),
  );

if (pending.length === 0) {
  console.log('No static mutants to prove. Nothing to do.');
  process.exit(0);
}

console.log(
  `Proving ${pending.length} ${ALL ? 'surviving' : 'static'} mutants against the suite.\n`,
);

const originals = new Map();
for (const { file } of pending) {
  if (!originals.has(file)) originals.set(file, readFileSync(file, 'utf8'));
}

const restore = () => {
  for (const [file, source] of originals) writeFileSync(file, source);
};

// Restore even on Ctrl-C: leaving a mutated source file behind would be worse
// than any failure this script can report.
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

const escaped = [];
const stale = [];
const claimed = new Map();

try {
  for (const { file, mutant } of pending) {
    const where = `${file}:${mutant.location.start.line} ${mutant.mutatorName}`;
    const entry = entryFor(file, mutant);
    const equivalent = entry !== undefined;
    if (entry !== undefined) claimed.set(entry, (claimed.get(entry) ?? 0) + 1);
    writeFileSync(file, applyMutant(originals.get(file), mutant));

    const survived = suitePasses();
    restore();

    const verdict = survived ? 'SURVIVED' : 'caught  ';
    console.log(`  ${verdict}  ${where}${equivalent ? '  (declared equivalent)' : ''}`);

    if (survived && !equivalent) escaped.push({ where, replacement: mutant.replacement });
    if (!survived && equivalent) stale.push(where);
  }
} finally {
  restore();
}

// --all is a survey, not a gate: Stryker already reported those, and it applies
// the replacement as WRITTEN, where Stryker parenthesises it. A sub-expression
// swap can therefore bind differently here than it did under Stryker, and the
// two disagree honestly — read both before believing either.
if (ALL) process.exit(0);

const miscounted = EQUIVALENT.filter((entry) => (claimed.get(entry) ?? 0) !== entry.count);
if (miscounted.length > 0) {
  console.error('\nAn equivalence claim covers a different number of mutants than declared:\n');
  for (const entry of miscounted) {
    console.error(
      `  ${entry.file}  ${entry.replacement}\n    declared ${entry.count}, matched ${claimed.get(entry) ?? 0}`,
    );
  }
  console.error('\nRead the new one before widening the claim to cover it.');
  process.exit(1);
}

if (stale.length > 0) {
  console.error('\nDeclared equivalent, but the suite caught them — the claim is wrong:\n');
  for (const where of stale) console.error(`  ${where}`);
  console.error('\nRemove the entry from EQUIVALENT in this script.');
  process.exit(1);
}

if (escaped.length > 0) {
  console.error(`\n${escaped.length} static mutant(s) no test noticed:\n`);
  for (const { where, replacement } of escaped) {
    console.error(
      `  ${where}\n    replaced with: ${replacement.replace(/\s+/g, ' ').slice(0, 120)}`,
    );
  }
  console.error('\nThese run once at module load and build a value everything else trusts.');
  process.exit(1);
}

console.log(`\nAll ${pending.length} static mutants accounted for.`);
