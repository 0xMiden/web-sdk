import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for React SDK integration tests.
 * These tests run in a real browser with the actual WASM SDK and MockWebClient.
 */
export default defineConfig({
  timeout: 120_000,
  testDir: "./test",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: "html",

  use: {
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testMatch: "*.test.ts",
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: "*.test.ts",
      // Every MockWebClient opens the same IndexedDB store. Under WebKit,
      // parallel workers intermittently see each other's mock chain there and
      // fail sync with "does not carry valid validator signatures", so the
      // WebKit project runs one test at a time. Chromium is unaffected.
      workers: 1,
    },
  ],

  webServer: {
    command: "node ./test/serve-tests.cjs",
    url: "http://127.0.0.1:8081",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
