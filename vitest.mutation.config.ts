import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The unit suite, flattened — for Stryker only.
 *
 * Stryker's vitest runner takes a config file, not a project name, so it cannot
 * be pointed at the `unit` project inside vitest.config.ts. This is that project
 * with the wrapper taken off.
 *
 * The integration suite is excluded, which is the whole reason this file exists:
 * mutation testing runs the suite once per surviving mutant, and a run that
 * needed a real MongoDB for every one of them would take hours and fail on any
 * machine without one.
 *
 * Coverage is absent on purpose. Stryker measures whether the tests DETECT a
 * change, which is the question line coverage cannot answer — running both at
 * once would only slow it down.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@platform': r('./src/platform'),
      '@modules': r('./src/modules'),
      '@ui': r('./src/ui'),
      '@': r('./src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'node_modules/**'],
  },
});
