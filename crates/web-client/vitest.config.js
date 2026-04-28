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
        // WASM-dependent files: these import from ../Cargo.toml (the wasm-bindgen
        // output) which is a binary WASM module not available in the node test
        // environment. Covered by Playwright integration tests.
        "js/wasm.js",
        "js/safe-arrays.js",
        "js/eager.js",
        "js/index.js",
        "js/client.js",
      ],
      thresholds: {
        lines: 0,
        branches: 0,
        functions: 0,
        statements: 0,
      },
    },
  },
});
