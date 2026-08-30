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
  {
    file: 'src/modules/catalog/application/import/column-mapping.ts',
    replacement: ';',
    count: 1,
    replay: 'survives',
    why: 'The claim-tracking cannot fire while no header spelling belongs to two fields, which a test asserts — a header matches at most one alias, so at most one field ever wants a column. It is kept because the day somebody adds "price" to compareAtPrice it stops being unreachable and starts being the thing that prevents every Shopify import pricing its products at the was-price.',
  },
  {
    file: 'src/modules/media/infrastructure/http-image-fetcher.ts',
    replacement: '"Stryker was here!"',
    count: 1,
    replay: 'survives',
    why: 'The trailing empty-string fallback on split(";")[0]?.trim(). String.split always returns at least one element, so the index is never undefined, the optional chain never short-circuits and the fallback is unreachable. It exists for noUncheckedIndexedAccess, which types the access as possibly undefined.',
  },
  {
    file: 'src/modules/media/infrastructure/http-image-fetcher.ts',
    replacement: "(header ?? '').split(';')[0].trim",
    count: 1,
    replay: 'survives',
    why: 'The same optional chain, from the other side: `[0]` is never undefined, so `?.` and `.` behave identically.',
  },
  {
    file: 'src/modules/media/infrastructure/r2-image-repository.ts',
    replacement: '"Stryker was here!"',
    count: 1,
    replay: 'survives',
    why: 'The same unreachable trailing fallback as the fetcher, on the same expression shape.',
  },
  {
    file: 'src/modules/media/infrastructure/r2-image-repository.ts',
    replacement: "(response.headers.get('content-type') ?? '').split(';')[0].trim",
    count: 1,
    replay: 'survives',
    why: 'The same optional chain as the fetcher, on the same expression shape.',
  },

  /*
   * The application layer, from here down.
   *
   * Written after the layer went from 88% to 97%, and every one of these was
   * looked at on its own before it was written down. Two shapes account for
   * most of them: a guard the type checker needs and the runtime does not, and
   * a check a later line makes redundant. Neither is dead code — each says
   * plainly what the function will not do — but neither can be observed from
   * outside, which is what makes them entries here rather than gaps.
   */
  {
    file: 'src/modules/cart/application/price-cart.ts',
    replacement: 'false',
    count: 2,
    replay: 'survives',
    why: 'Two guards, each made redundant by the line under it. `compareAtPrice === null` narrows for TypeScript: without it, isOnOffer still answers false for a variant with no was-price, so the ternary returns null and `.cents` is never read off null. The out-of-stock early return builds `{ not_enough, available: 0 }`, and out_of_stock means a tracked level at zero — createStockLevel refuses a negative count and the repository parses onHand as z.number().int().min(0) — so countToShow gives 0, `0 >= quantity` is false for every cart line (readLine drops q < 1), and the fall-through builds that same object.',
  },
  {
    file: 'src/modules/cart/application/price-cart.ts',
    replacement: '""',
    count: 1,
    replay: 'survives',
    why: 'The out-of-stock guard from the other side: no availability equals "", so the branch is skipped and the fall-through reports the same available: 0.',
  },
  {
    file: 'src/modules/catalog/application/import/parse-cell.ts',
    replacement: '/(\\d{4})-(\\d{2})-(\\d{2})$/',
    count: 1,
    replay: 'survives',
    why: 'Dropping the leading anchor lets "x2026-01-02" reach the parser, and the line below compares parsed.toISOString().slice(0, 10) against the RAW cell — ten characters against eleven — so it comes back unparsable_date with the same value either way. That round trip was written to catch 2026-02-31 rolling into March; it makes both anchors unobservable as a side effect.',
  },
  {
    file: 'src/modules/catalog/application/import/parse-cell.ts',
    replacement: '/^(\\d{4})-(\\d{2})-(\\d{2})/',
    count: 1,
    replay: 'survives',
    why: 'The trailing anchor, refused by the same round trip: a ten-character slice cannot equal a longer string, so "2026-01-02 (approx)" is unparsable_date with or without the $.',
  },
  {
    file: 'src/modules/catalog/application/import/plan-import.ts',
    replacement: 'false',
    count: 1,
    replay: 'survives',
    why: '`index === undefined ? undefined : values[index]` without its guard is `values[undefined]`, which JavaScript evaluates to undefined. The guard is there for noUncheckedIndexedAccess, which types the access as possibly absent.',
  },
  {
    file: 'src/modules/catalog/application/import/plan-import.ts',
    replacement: 'row.image.url',
    count: 1,
    replay: 'survives',
    why: 'The optional chain sits inside `row.image !== null && ...`, so the access is already safe when it runs. TypeScript cannot carry that narrowing into the some() callback, which is the whole reason the ?. is written.',
  },
  {
    file: 'src/modules/catalog/application/import-products.ts',
    replacement: '["Stryker was here"]',
    count: 1,
    replay: 'survives',
    why: 'The [] is only evaluated when slugs.length is 0, which means the provisional plan produced neither a product nor a product problem. It becomes existingBySlug, and the only read of that map is get(first.slug), once per planned product — of which there are none. The twin on the next line is NOT equivalent and Stryker kills it: skuOwners is iterated for owner.variants, which throws on a string.',
  },
  {
    file: 'src/modules/catalog/application/quick-view.ts',
    replacement: 'false',
    count: 3,
    replay: 'survives',
    why: 'The narrowing check and each half of it. `if (!isOnOffer(variant, now)) return null` on the next line refuses everything this one does, because isOnOffer requires both a was-price and an end date. The guard exists so TypeScript can see compareAtPrice.cents and offerEndsAt.toISOString() as safe.',
  },
  {
    file: 'src/modules/catalog/application/quick-view.ts',
    replacement: 'compareAtPrice === null && offerEndsAt === null',
    count: 1,
    replay: 'survives',
    why: 'Swapping || for && narrows what returns early, and isOnOffer returns null a line later for every case that stops returning early here.',
  },
  {
    file: 'src/modules/catalog/application/search-products.ts',
    replacement: 'false',
    count: 1,
    replay: 'survives',
    why: 'In `value === undefined || !Number.isFinite(value)` the left disjunct is subsumed by the right: Number.isFinite(undefined) is false, so both spellings return undefined for an absent number.',
  },
  {
    file: 'src/modules/catalog/application/search-products.ts',
    replacement: '["Stryker was here"]',
    count: 1,
    replay: 'survives',
    why: 'The `?? []` is only reached when no options were asked for, and the loop drops any entry whose values clean to nothing — cleanValues(undefined) is [...new Set(undefined)], which is empty rather than a throw. No fallback array can add a filter.',
  },
  {
    file: 'src/modules/catalog/application/search-products.ts',
    replacement: 'true',
    count: 4,
    replay: 'survives',
    why: 'Four `!== undefined` guards whose comparison is false for undefined anyway: `undefined < 0` is false, and `minCents > maxCents` is false whenever either side is undefined. The same family as the five in collection.ts, one layer up.',
  },
  {
    file: 'src/modules/catalog/application/search-products.ts',
    replacement: 'minCents !== undefined || maxCents !== undefined',
    count: 1,
    // The second place the two tools disagree, and for exactly the reason they
    // disagree in collection.ts — the same shape of expression, one layer up.
    replay: 'caught',
    why: 'Equivalent as Stryker ran it: `(minCents !== undefined || maxCents !== undefined) && minCents > maxCents` still needs both bounds before the comparison can be true. Not equivalent as the report PRINTS it, because && binds tighter — the splice reads `minCents !== undefined || (maxCents !== undefined && minCents > maxCents)`, which refuses every search carrying a minimum price. The replay catches it and Stryker did not, and both are right about different mutations.',
  },
  {
    file: 'src/modules/orders/application/place-order.ts',
    replacement: 'false',
    count: 1,
    replay: 'survives',
    why: 'Whitespace-only notes, normalised twice. Without this check the spaces are passed on, and createOrder turns blank(notes) into null before an Order exists — so the order is identical. It stays because the layer assembling the input should not lean on the domain tidying up after it, but nothing outside can tell.',
  },
  {
    file: 'src/modules/orders/application/place-order.ts',
    replacement: 'input.notes',
    count: 1,
    replay: 'survives',
    why: 'The same normalisation from the other side: testing the untrimmed length only changes the answer for notes that are all whitespace, and those are the ones createOrder turns into null anyway.',
  },
  /*
   * The workbook reader, which is one long narrowing.
   *
   * Every entry below is the same argument in a different place: this file
   * takes `unknown` from a library reading a file a stranger uploaded, and
   * turns it into `string[][]`. The guards that do the turning are required by
   * the type checker and unreachable at runtime, because the library either
   * answers in the one shape it has (checked against the library itself, in
   * `xlsx-workbook-reader.test.ts`) or throws before any of them is asked.
   *
   * That is why the file scores 73.53% while every test in it passes: it is
   * thirty-four mutants, of which nine are the boundary itself.
   */
  {
    file: 'src/modules/catalog/infrastructure/xlsx-workbook-reader.ts',
    replacement: 'false',
    count: 4,
    replay: 'survives',
    why: 'The four narrowing guards. `value === undefined` never fires because the library writes null into a gap, never undefined — probed, not assumed. The other three exist so TypeScript will let `unknown` be indexed, spread and mapped: a non-array from readXlsxFile, a workbook with no sheets, and a first sheet whose `data` is not an array. The library throws on all three before returning, so none is reachable through a file.',
  },
  {
    file: 'src/modules/catalog/infrastructure/xlsx-workbook-reader.ts',
    replacement: '""',
    count: 2,
    replay: 'survives',
    why: 'The two refusal messages, on throws no file can reach. They are for the day the library changes shape under an upgrade, which is also what the contract test in the spec is watching for — the test fails first, and with a better explanation.',
  },
  {
    file: 'src/modules/catalog/infrastructure/xlsx-workbook-reader.ts',
    replacement: '["Stryker was here"]',
    count: 2,
    replay: 'survives',
    why: 'Two empty arrays on paths nothing reaches: the answer for a workbook with no sheets, and the answer for a row that is not an array. A workbook with no sheets makes the library throw internally rather than return one, and every row it does return is an array.',
  },
  {
    file: 'src/modules/catalog/infrastructure/xlsx-workbook-reader.ts',
    replacement: 'String(value)',
    count: 1,
    replay: 'survives',
    why: 'The trim, which the library has already done. Deleting it from the reader leaves every test in the file passing — checked, which is why the test that looks like it covers this says in so many words that it does not. It stays as a second layer at an untrusted boundary, and it is declared rather than left looking tested.',
  },
  {
    file: 'src/modules/store/application/update-store-settings.ts',
    replacement: '""',
    count: 1,
    replay: 'survives',
    why: "hundredths returns Result<number, 'unparsable'> and neither caller reads the error VALUE — each checks .ok and builds its own tagged error carrying the input, and for a delivery fee the region as well. The string names a channel nobody listens on.",
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
