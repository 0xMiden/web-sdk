import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["fake-indexeddb/auto"],
    coverage: {
      // The static `provider: "v8"` reference is what knip's vitest
      // plugin reads to discover `@vitest/coverage-v8` as a real
      // dependency. Without it, knip flags the package as unused.
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html", "lcov"],
      include: ["ts/**/*.ts"],
      exclude: ["ts/**/*.test.ts", "ts/test-utils.ts"],
      // No thresholds yet on next — the napi additions (notes.ts,
      // settings.ts, sync.ts, transactions.ts, etc.) currently sit
      // at ~0% coverage. Main's 95/95/95/95 gate stays, and we ratchet
      // next up to it as tests get backfilled. Tracked separately.
    },
  },
});
