import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.d.ts"],
      // Phase 0: measurement-mode. Restored to 95 in Phase 4.
      thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 },
    },
  },
});
