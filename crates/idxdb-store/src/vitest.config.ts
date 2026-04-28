import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["fake-indexeddb/auto"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["ts/**/*.ts"],
      exclude: ["ts/**/*.test.ts", "ts/test-utils.ts"],
      // Phase 0: measurement-mode. Restored to 95 in Phase 4.
      thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 },
    },
  },
});
