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
