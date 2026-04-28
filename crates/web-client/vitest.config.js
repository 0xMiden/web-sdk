import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["js/__tests__/**/*.test.js"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html", "lcov"],
      include: ["js/**/*.js"],
      exclude: [
        "js/__tests__/**",
        "js/types/**",
        // Web Worker code: tested separately by Playwright integration tests
        // since the worker pattern doesn't unit-test cleanly in node.
        "js/workers/**",
        // Node.js binding entry + napi adapters: depend on the platform-
        // specific napi binary which isn't available in the node-test env
        // (and which we don't ship for the test runner architecture).
        // Covered by the Web client tests (Node.js) job.
        "js/node-index.js",
        "js/node/**",
        // WASM-dependent files: import from ../Cargo.toml (the wasm-bindgen
        // output) which is a binary WASM module not available in the node
        // test environment. Covered by Playwright integration tests.
        "js/wasm.js",
        "js/eager.js",
        "js/index.js",
        "js/client.js",
        "js/storageView.js",
        // Tests not yet ported on next — main has them, but the source has
        // drifted from the napi-binding sync (PR #13) enough that the tests
        // need review before they apply. Tracked for a follow-up PR. Once
        // each gains a test file in js/__tests__/, drop it from this list.
        "js/utils.js",
        "js/resources/accounts.js",
        "js/resources/compiler.js",
        "js/resources/keystore.js",
        "js/resources/transactions.js",
      ],
      thresholds: {
        lines: 95,
        branches: 95,
        functions: 95,
        statements: 95,
      },
    },
  },
});
