import { defineWorkspace } from "vitest/config";

// Each entry points to that package's existing vitest config — the
// per-package config remains the source of truth for environment,
// includes, coverage thresholds, etc. Vitest workspace mode runs
// them together when invoked from the repo root.
//
// `crates/web-client` ships its vitest config as `.js` (not `.ts`),
// so the path reflects that.
export default defineWorkspace([
  "./packages/react-sdk/vitest.config.ts",
  "./packages/vite-plugin/vitest.config.ts",
  "./crates/web-client/vitest.config.js",
]);
