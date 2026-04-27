import { defineConfig, devices } from "@playwright/test";

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import dotenv from 'dotenv';
// import path from 'path';
// dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * See https://playwright.dev/docs/test-configuration.
 */

// CI-only shard projects, manually rebalanced to even out wall-clock time
// across the integration-test matrix.
//
// Background: Playwright's built-in `--shard=N/M` splits files
// alphabetically. With our 30-test layout that produced wildly unbalanced
// shards — shard 5 (note_transport, notes, package, prune_account_history,
// remote_keystore, settings) took 41 min while shards 1, 3, 7 finished in
// 2 min each. The 41-min shard dictated the critical path of every PR.
//
// The 4 shards below are sized empirically from PR #1's run timings and
// an educated guess about which files do real chain/network work. The
// goal is for each shard to land in 12-18 min so the critical path drops
// from ~41 min to ~18 min.
//
// To rebalance after observing new runs: move file paths between the
// testMatch arrays. No CI workflow changes needed.
//
// Gated on `CI` so local `yarn test` doesn't run every test twice (once
// in `chromium`, once in a shard project).
const ciShardProjects = process.env.CI
  ? [
      {
        name: "ci-shard-1-tx-flows",
        use: { ...devices["Desktop Chrome"] },
        testMatch: [
          "test/new_transactions.test.ts",
          "test/swap_transactions.test.ts",
          "test/transactions.test.ts",
        ],
      },
      {
        name: "ci-shard-2-sync-and-state",
        use: { ...devices["Desktop Chrome"] },
        testMatch: [
          "test/sync_lock.test.ts",
          "test/tags.test.ts",
          "test/store_isolation.test.ts",
          "test/notes.test.ts",
          "test/note_transport.test.ts",
        ],
      },
      {
        name: "ci-shard-3-accounts-and-keys",
        use: { ...devices["Desktop Chrome"] },
        testMatch: [
          "test/account.test.ts",
          "test/account_component.test.ts",
          "test/account_file.test.ts",
          "test/account_reader.test.ts",
          "test/new_account.test.ts",
          "test/multisig_component.test.ts",
          "test/key.test.ts",
          "test/remote_keystore.test.ts",
          "test/import_export.test.ts",
          "test/import.test.ts",
        ],
      },
      {
        name: "ci-shard-4-compile-and-misc",
        use: { ...devices["Desktop Chrome"] },
        testMatch: [
          "test/fpi.test.ts",
          "test/compile_and_contract.test.ts",
          "test/package.test.ts",
          "test/mockchain.test.ts",
          "test/miden_array.test.ts",
          "test/miden_client_api.test.ts",
          "test/address.test.ts",
          "test/eager_entry.test.ts",
          "test/basic_fungible_faucet_component.test.ts",
          "test/prune_account_history.test.ts",
          "test/settings.test.ts",
          "test/token_symbol.test.ts",
        ],
      },
    ]
  : [];

export default defineConfig({
  timeout: 240_000,
  testDir: "./test",
  /* Run tests in files in parallel */
  fullyParallel: process.env.TEST_MIDEN_PROVER_URL ? false : true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 2 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: "html",
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    // baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "on-first-retry",
  },

  /* Configure projects for major browsers */
  projects: [
    // Default chromium project — runs all .test.ts files. Used by local
    // `yarn test` and any CI invocation that doesn't pass `--project`.
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testMatch: "*.test.ts",
    },

    // CI-only manually-balanced shard projects (definitions above the
    // defineConfig call).
    ...ciShardProjects,

    // {
    //   name: "firefox",
    //   use: { ...devices["Desktop Firefox"] },
    // },

    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  // FIXME: Modularise test server constants (localhost, port)
  webServer: {
    command: "npx http-server ./dist -a localhost -p 8080",
    url: "http://localhost:8080",
    reuseExistingServer: true,
  },
});
