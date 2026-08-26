#!/usr/bin/env node
/**
 * Verify that the architecture rules can actually fail.
 *
 * WHY THIS EXISTS
 * ---------------
 * `depcruise` reporting "no violations" means one of two very different things:
 * the code is clean, or the rule is broken and cannot fire. They look identical.
 *
 * Two of the sixteen rules here were inert when first written: they matched the
 * import specifier (`^mongodb$`) while dependency-cruiser matches the resolved
 * path — which under pnpm is
 * `node_modules/.pnpm/mongodb@7.6.0_socks@2.8.9/node_modules/mongodb/lib/index.js`.
 * Both rules passed on a codebase that violated them.
 *
 * So each rule below gets a file that should break it. If the rule stays silent,
 * this script fails the build.
 *
 *   node scripts/verify-boundary-rules.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const PROBES = [
  {
    rule: 'app-uses-module-barrels-only',
    file: 'src/app/__probe__.ts',
    code: "import { createStoreSettings } from '@modules/store/domain/store-settings';\nexport const probe = createStoreSettings;\n",
  },
  {
    rule: 'composition-uses-module-barrels-only',
    file: 'src/composition/__probe__.ts',
    code: "import { createStoreSettings } from '@modules/store/domain/store-settings';\nexport const probe = createStoreSettings;\n",
  },
  {
    rule: 'no-db-driver-outside-infrastructure',
    file: 'src/modules/store/domain/__probe__.ts',
    code: "import type { Db } from 'mongodb';\nexport type Probe = Db;\n",
  },
  {
    rule: 'no-next-inside-modules',
    file: 'src/modules/store/domain/__probe2__.ts',
    code: "import { notFound } from 'next/navigation';\nexport const probe = notFound;\n",
  },
  {
    rule: 'no-next-inside-modules',
    file: 'src/modules/store/domain/__probe3__.ts',
    code: "import { useState } from 'react';\nexport const probe = useState;\n",
  },
  {
    rule: 'application-does-not-touch-infrastructure',
    file: 'src/modules/store/application/__probe__.ts',
    code: "import { STORE_SETTINGS_COLLECTION } from '../infrastructure/mongo-store-settings-repository';\nexport const probe = STORE_SETTINGS_COLLECTION;\n",
  },
  {
    rule: 'domain-knows-nothing',
    file: 'src/modules/store/domain/__probe4__.ts',
    code: "import { makeGetStoreSettings } from '../application/get-store-settings';\nexport const probe = makeGetStoreSettings;\n",
  },
  {
    rule: 'platform-is-the-floor',
    file: 'src/platform/__probe__.ts',
    code: "import { createStoreModule } from '@modules/store';\nexport const probe = createStoreModule;\n",
  },
  {
    rule: 'ui-is-pure',
    file: 'src/ui/__probe__.ts',
    code: "import { createStoreModule } from '@modules/store';\nexport const probe = createStoreModule;\n",
  },
  {
    rule: 'composition-is-wired-only-by-app',
    file: 'src/modules/store/domain/__probe5__.ts',
    code: "import { getContainer } from '@/composition';\nexport const probe = getContainer;\n",
  },
  {
    rule: 'modules-never-import-ui',
    file: 'src/modules/store/domain/__probe6__.ts',
    code: "import { Panel } from '@ui/primitives/panel';\nexport const probe = Panel;\n",
  },
];

const cruise = () => {
  try {
    return execFileSync(
      process.execPath,
      [
        'node_modules/dependency-cruiser/bin/dependency-cruise.mjs',
        'src',
        '--config',
        '.dependency-cruiser.cjs',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    // A non-zero exit is the expected outcome when a probe trips a rule.
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
};

const baseline = cruise();
if (!baseline.includes('no dependency violations found')) {
  console.error('The tree already has violations; fix those before verifying the rules.\n');
  console.error(baseline);
  process.exit(1);
}

let failed = false;
console.log('\n  Verifying each boundary rule can actually fail:\n');

for (const { rule, file, code } of PROBES) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, code, 'utf8');

  const output = cruise();

  rmSync(file, { force: true });

  if (output.includes(rule)) {
    console.log(`    caught   ${rule}  (${file})`);
  } else {
    failed = true;
    console.log(`    INERT    ${rule}  (${file})  <-- rule did not fire`);
  }
}

const after = cruise();
if (!after.includes('no dependency violations found')) {
  console.error('\n  Probe cleanup left the tree dirty:\n');
  console.error(after);
  process.exit(1);
}

if (failed) {
  console.error('\n  At least one rule cannot fail, so it is not protecting anything.\n');
  process.exit(1);
}

console.log(`\n  All ${PROBES.length} probes tripped their rule.\n`);
