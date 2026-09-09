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
        "js/storageView.js",
        // `client.js` imports no WASM itself, so its instance surface unit-tests
        // fine — `__tests__/client.test.js` and `client.surface.test.js` do
        // exercise it. It stays excluded because its static constructors
        // (`create`, `createTestnet`, `createDevnet`, `createMock`) drive the
        // injected wasm-bindgen classes and the worker setup, which is the bulk
        // of the file and is covered by the Playwright integration tests. Include
        // it once those constructors have unit coverage; today it measures ~64%
        // and would fail the threshold.
        "js/client.js",
        // Tests not yet ported on next — main has them, but the source has
        // drifted from the napi-binding sync (PR #13) enough that the tests
        // need review before they apply. Tracked for a follow-up PR. Once
        // each gains a test file in js/__tests__/, drop it from this list.
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
