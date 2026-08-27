import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

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
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          // Integration tests need a real Mongo and live in a separate project so
          // that `pnpm test` stays runnable offline, on a plane, in under a second.
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.integration.test.ts'],
          // A real database is slower and must not run in parallel against one
          // collection; correctness beats wall-clock here.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'json', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Only MODULE barrels are pure re-exports. A blanket 'src/**/index.ts'
        // here silently excluded every platform primitive — result, money, ids,
        // clock, logger, config, flags are all index.ts — and made the 95%
        // platform threshold pass against nothing at all.
        'src/modules/*/index.ts',
        'src/app/**',
        'src/composition/**',
        'src/platform/mongo/**',
        // Adapters are exercised by the integration project against a real
        // MongoDB, which cannot run in this pass. Gating them on unit-run line
        // coverage would fail permanently and prove nothing; what actually
        // guards them is the integration suite's explain() assertion that
        // rejects a COLLSCAN.
        'src/modules/**/infrastructure/**',
        'src/**/*.d.ts',
      ],
      /**
       * Per-directory gates, not one global number. A single global threshold
       * lets 100%-covered utility code pay for an untested use case — exactly the
       * trade this architecture exists to prevent.
       */
      thresholds: {
        // The layer that must never be wrong, and has no excuse: pure, no IO.
        'src/modules/**/domain/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // Where every decision lives, because Server Components cannot be tested.
        'src/modules/**/application/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'src/platform/**': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
});
