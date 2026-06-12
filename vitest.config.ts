import { defineConfig } from "vitest/config";

// Vitest 3 modern shape: `test.projects` supersedes the older
// `defineWorkspace` API. Each entry points to that package's
// existing vitest config — the per-package config remains the
// source of truth for environment, includes, coverage thresholds,
// etc. Running `vitest` from the repo root aggregates them.
//
// `crates/web-client` ships its vitest config as `.js` (not `.ts`),
// so the path reflects that.
export default defineConfig({
  test: {
    projects: [
      "./packages/react-sdk/vitest.config.ts",
      "./packages/vite-plugin/vitest.config.ts",
      "./crates/web-client/vitest.config.js",
    ],
  },
});
