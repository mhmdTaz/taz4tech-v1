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
 * Mutants no test can kill, each with the reason it cannot.
 *
 * Kept short and argued. An entry here is a claim that the mutation changes
 * nothing observable — not that writing the test looked like work. Every one is
 * still replayed against the real suite, and every one declares what that
 * replay should do; a claim whose outcome changes is a claim that has gone
 * stale, and the run fails rather than leaving it on the survivor list looking
 * settled.
 *
 * `replay` is what the TEXTUAL splice is expected to produce, which is not
 * always what Stryker produced. Stryker parenthesises what it substitutes; this
 * script writes the replacement into the file exactly as the report prints it.
 * For a swapped operator inside a larger expression the two can bind
 * differently, and where they do the entry says so rather than the disagreement
 * being read as a bug in either.
 */
const EQUIVALENT = [
  {
    file: 'src/modules/orders/domain/order.ts',
    replacement: '["Stryker was here"]',
    // Matched on file and replacement rather than on a line, which would drift
    // with every edit above it. `count` is what stops the exemption from
    // quietly spreading to a new array added to the same file later.
    count: 2,
    replay: 'survives',
    why: 'The transition table is searched with includes() against a real OrderStatus, and "Stryker was here" is not one. A mutation the type system forbids is not a gap in the tests.',
  },
  {
    file: 'src/modules/catalog/domain/collection.ts',
    replacement: '["Stryker was here"]',
    count: 1,
    replay: 'survives',
    why: 'The `?? []` fallback is only reached when rules.brands is absent, and the loop it feeds only refuses a BLANK brand. Any array of non-blank strings behaves identically, so no fallback value can be distinguished from the empty one.',
  },
  {
    file: 'src/modules/catalog/domain/collection.ts',
    replacement: 'true',
    count: 5,
    replay: 'survives',
    why: 'The five `x !== undefined` guards. Each exists for the type checker, not for the runtime: `undefined < 0` and `undefined > n` are both false, so dropping a guard leaves the comparison it protects false anyway. Distinguishing one would need a comparison against undefined to be TRUE, which JavaScript never does.',
  },
  {
    file: 'src/modules/catalog/domain/collection.ts',
    replacement: 'min !== undefined || max !== undefined',
    count: 1,
    // The one place the two tools disagree, and the disagreement is real rather
    // than a fault: Stryker ran `(min !== undefined || max !== undefined) && min > max`,
    // which is equivalent; written into the file as printed, `&&` binds tighter
    // and it becomes `min !== undefined || (max !== undefined && min > max)`,
    // which refuses every open-ended price rule.
    replay: 'caught',
    why: 'Equivalent as Stryker ran it, because reaching `min > max` still needs both bounds. Not equivalent as the report PRINTS it, because && binds tighter than || — so the replay catches it and Stryker did not, and both are right about different mutations.',
  },
  {
    file: 'src/modules/catalog/domain/product.ts',
    replacement: '/^-|-+$/g',
    count: 1,
    replay: 'survives',
    why: 'A double hyphen cannot exist at this point: the line above replaces every run of non-alphanumerics with ONE hyphen, so `-+` can only ever match a single character.',
  },
  {
    file: 'src/modules/catalog/domain/product.ts',
    replacement: '/^-+|-$/g',
    count: 1,
    replay: 'survives',
    why: 'Same as the leading-hyphen case: runs are already collapsed, so `-+` and `-` match identically here.',
  },
  {
    file: 'src/modules/catalog/domain/product.ts',
    replacement: '/-$/g',
    count: 1,
    replay: 'survives',
    why: 'The slice cannot create a double hyphen either, so the trailing trim has at most one character to remove.',
  },
  {
    file: 'src/modules/catalog/domain/product.ts',
    replacement: 'compare(price, lowest) <= 0',
    count: 1,
    replay: 'survives',
    why: 'On a tie this returns the other Money value, and Money is { cents, currency } with Currency a single-member union — two that compare equal are structurally identical. Which object comes back is not a question a caller can ask.',
  },
  {
    file: 'src/modules/catalog/domain/product.ts',
    replacement: 'compare(price, highest) >= 0',
    count: 1,
    replay: 'survives',
    why: 'The same tie, at the other end of the range.',
  },
  {
    file: 'src/modules/cart/domain/cart.ts',
    replacement: 'false',
    count: 5,
    replay: 'survives',
    why: 'Five guards in parseCart/readLine whose case a later check refuses anyway: an absent or empty cookie reaches base64 decoding and throws into the catch; a null decode is stringified by JSON.parse and fails Array.isArray; a non-object entry destructures to undefined fields and fails the typeof checks below; a non-number quantity fails Number.isInteger. Each states its case plainly instead of leaving control flow to depend on a throw, which is why they stay.',
  },
  {
    file: 'src/modules/cart/domain/cart.ts',
    replacement: '{}',
    count: 2,
    replay: 'survives',
    why: 'The two catch blocks. Emptying either leaves the value undefined rather than EMPTY_CART or null, and every path from there ends at the same empty cart — Array.isArray(undefined) is false, and JSON.parse(undefined) throws into the outer catch.',
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
      .filter(
        (mutant) =>
          UNPROVEN.has(mutant.status) &&
          // Static ones because Stryker could not reach them; declared ones
          // because a claim nobody re-checks is a claim that quietly rots.
          (ALL || mutant.static === true || entryFor(file, mutant) !== undefined),
      )
      .map((mutant) => ({ file, mutant })),
  );

if (pending.length === 0) {
  console.log('Nothing to prove.');
  process.exit(0);
}

console.log(`Replaying ${pending.length} surviving mutants against the suite.\n`);

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
    // Each declared entry says what the replay should do. Usually "survives" —
    // it is an equivalence claim. One says "caught", because the report prints
    // a replacement that binds differently from the one Stryker ran.
    const expected = entry?.replay ?? 'survives';
    const asExpected = survived === (expected === 'survives');

    console.log(
      `  ${verdict}  ${where}${equivalent ? `  (declared equivalent, expected to be ${expected === 'survives' ? 'unkillable' : 'caught by the replay'})` : ''}`,
    );

    if (survived && !equivalent) escaped.push({ where, replacement: mutant.replacement });
    if (equivalent && !asExpected) {
      stale.push(`${where} — declared ${expected}, replay ${survived ? 'survived' : 'caught it'}`);
    }
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
  console.error('\nAn equivalence claim no longer behaves the way it says it does:\n');
  for (const where of stale) console.error(`  ${where}`);
  console.error(
    '\nEither the code changed and the mutant is now killable — write the test and\n' +
      'remove the entry — or the claim was wrong to begin with. Do not move the\n' +
      'expectation to match the observation without reading why it moved.',
  );
  process.exit(1);
}

if (escaped.length > 0) {
  console.error(`\n${escaped.length} mutant(s) survived with nothing said about them:\n`);
  for (const { where, replacement } of escaped) {
    console.error(
      `  ${where}\n    replaced with: ${replacement.replace(/\s+/g, ' ').slice(0, 120)}`,
    );
  }
  console.error(
    '\nEither write a test that catches it, or add it to EQUIVALENT with the reason\n' +
      'no test can. A survivor with no argument next to it is one nobody has read.',
  );
  process.exit(1);
}

console.log(
  `\nAll ${pending.length} accounted for: caught by the suite, or declared equivalent\n` +
    'with an argument and behaving as declared.',
);
