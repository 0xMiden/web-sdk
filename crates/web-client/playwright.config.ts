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

// Browser test ignores: skip Node.js-only specs (the napi versions of certain
// tests live in *.node.test.ts) and old test/{node,shared}/ duplicates.
const browserTestIgnore = [
  "test/node/**",
  "test/shared/**",
  // Node.js-only tests (napi-specific JS wrapper)
  "test/*.node.test.ts",
];

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
// Gated on `CI` so local `pnpm test` doesn't run every test twice (once
// in `chromium`, once in a shard project).
const ciShardProjects = process.env.CI
  ? [
      // Heuristic rebalance from PR #10 timings: shard-1 ran 27m (3 files,
      // 19 tests, all heavy E2E tx flows) while shard-3 and shard-4 ran in
      // ~14.7m. Moving transactions.test.ts (2 heavy E2E cases) from shard-1
      // to shard-4 evens the wall-clock. Moving store_isolation.test.ts
      // (7 tests, medium) from shard-2 to shard-3 lightens shard-2 (was 19m40s).
      // The JSON reporter on the next CI run will produce per-test timings
      // for an evidence-based pass.
      //
      // PR #11 split new_transactions.test.ts (16 tests, ~1601 lines) into
      // two roughly equal halves so shard-1's 2 workers can parallelize them:
      //   new_transactions_send_and_custom.test.ts  (~6 tests, ~801 lines)
      //   new_transactions_mint_and_misc.test.ts    (~10 tests, ~800 lines)
      // Estimated shard-1 wall clock: 28m → ~16m (-43%).
      {
        name: "ci-shard-1-tx-flows",
        use: { ...devices["Desktop Chrome"] },
        testMatch: [
          "test/new_transactions_send_and_custom.test.ts",
          "test/new_transactions_mint_and_misc.test.ts",
          "test/swap_transactions.test.ts",
        ],
        testIgnore: browserTestIgnore,
      },
      {
        name: "ci-shard-2-sync-and-state",
        use: { ...devices["Desktop Chrome"] },
        testMatch: [
          "test/sync_lock.test.ts",
          "test/tags.test.ts",
          "test/notes.test.ts",
          "test/note_transport.test.ts",
        ],
        testIgnore: browserTestIgnore,
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
          "test/store_isolation.test.ts",
        ],
        testIgnore: browserTestIgnore,
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
          "test/basic_fungible_faucet_component.test.ts",
          "test/prune_account_history.test.ts",
          "test/settings.test.ts",
          "test/token_symbol.test.ts",
          "test/transactions.test.ts",
        ],
        testIgnore: browserTestIgnore,
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
  /* Retry once on CI to mask intermittent infra flakes (browser-side
   * `TypeError: Failed to fetch` against the in-process gRPC mock node).
   * The previous root-cause attempts (TCP probe, stdout-grep readiness)
   * either didn't help or interacted badly with stdout buffering on
   * WarpBuild runners. The flake hits at low single-digit %, so a single
   * retry is enough to keep CI reliable without doubling cost. */
  retries: process.env.CI ? 1 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 2 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  // On CI: also emit a JSON report so per-test timings can be extracted
  // from artifacts (used for evidence-based shard rebalancing). The JSON
  // file lands at playwright-report/results.json.
  reporter: process.env.CI
    ? [
        ["html", { open: "never" }],
        ["json", { outputFile: "playwright-report/results.json" }],
      ]
    : "html",
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
    // `pnpm test` and any CI invocation that doesn't pass `--project`.
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testMatch: "*.test.ts",
      testIgnore: browserTestIgnore,
    },

    // CI-only manually-balanced shard projects (definitions above the
    // defineConfig call).
    ...ciShardProjects,

    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testIgnore: browserTestIgnore,
    },

    // Node.js project: exercises the napi binding against a mock chain.
    // Uses the same .test.ts files as the browser projects but skips the
    // ones that depend on browser-only globals (IndexedDB, WASM-array
    // `.length()`, exportStore/importStore, etc). The corresponding
    // `*.node.test.ts` files are the napi-specific variants.
    {
      name: "nodejs",
      testDir: "./test",
      testMatch: "**/*.test.ts",
      // Skip browser-only and WASM-specific tests
      testIgnore: [
        "test/store_isolation*",
        "test/sync_lock*",
        "test/import_export*",
        "test/remote_keystore*",
        "test/package*", // TestUtils (createMockSerialized*) is browser-only
        "test/miden_array*", // WASM array .length() method not available in Node.js
        "test/shared/**", // Old format duplicates (ported to root test/)
        "test/node/**", // Old format duplicates (ported to root test/)
        "test/remote_prover_transactions*", // Old browser format for chromium CI
        // Browser-only variants — napi versions live in *.node.test.ts
        "test/miden_client_api.test.ts",
        "test/compile_and_contract.test.ts",
        // Browser-only tests preserved from `next` that use exportStore /
        // importStore / waitForBlocks / isolatedClient (all browser-only).
        "test/*.browser.test.ts",
      ],
      // Skip specific browser-only tests by name.
      // Tests that request the `page` fixture must be listed here because
      // Playwright launches the browser for the fixture BEFORE test.skip()
      // in the test body can run.
      grepInvert:
        /exportStore|importStore|reads updated state after a mutating|accounts\.insert stores a pre-built/,
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
  // Skip webServer when running only Node.js tests (no browser/dist needed)
  ...(process.env.SKIP_WEB_SERVER
    ? {}
    : {
        webServer: {
          command: "npx http-server ./dist -a localhost -p 8080",
          url: "http://localhost:8080",
          reuseExistingServer: true,
        },
      }),
});
