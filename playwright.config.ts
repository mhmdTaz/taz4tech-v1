import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * Sharded four ways in CI (see the e2e matrix in ci.yml). Sharding is by test
 * file, so the suite has to be split into several files to actually parallelise —
 * one giant spec would leave three shards idle.
 */
const PORT = 3000;
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * Test-only admin password, exported so the specs use the same literal the
 * server was started with rather than a copy that can drift out of step.
 */
export const ADMIN_PASSWORD = 'e2e-admin-password';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,

  // A test that only passes on the second try is a flaky test, and a flaky suite
  // stops being read. CI retries once to absorb genuine infrastructure blips.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  ...(process.env.CI ? { workers: 2 } : {}),

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],

  expect: { timeout: 10_000 },
  timeout: 60_000,

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile-chromium',
      // Most Lebanese traffic is mobile, so the mobile viewport is a first-class
      // target rather than an afterthought.
      use: { ...devices['Pixel 7'] },
    },
  ],

  webServer: {
    command: 'pnpm start',
    url: `${baseURL}/en`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      NODE_ENV: 'production',
      MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
      MONGODB_DB: process.env.MONGODB_DB ?? 'taz4tech_e2e',
      STORE_ID: process.env.STORE_ID ?? 'taz4tech',
      SITE_URL: baseURL,
      // The admin area only exists when both are set, which is what the admin
      // specs need. A throwaway pair — never the values used anywhere real.
      ADMIN_PASSWORD: ADMIN_PASSWORD,
      ADMIN_SESSION_SECRET: 'e2e-session-secret-that-is-long-enough-0123456789',
      TAZ_FLAG_EXCEL_IMPORTER: 'on',
    },
  },
});
