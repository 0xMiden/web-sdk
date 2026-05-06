#!/usr/bin/env node
// Copy hand-authored .d.ts overrides from js/types/ into each variant's
// dist subdir, then run clean.js to strip the `wasm.js` entry stub.
//
// Why: the rollup build emits dist/{st,mt}/index.d.ts from the
// wasm-bindgen-generated declarations, but the public surface lives in
// js/types/index.d.ts (hand-authored to expose the higher-level
// MidenClient resource API). Overlay copies the hand-authored set on top
// of the generated baseline. Either or both subdirs may exist depending
// on which variants the build produced (MIDEN_FAST_BUILD=true skips MT).

import { cpSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const variants = ["st", "mt"].filter((v) => existsSync(join("dist", v)));
if (variants.length === 0) {
  console.error(
    "[build-types] No dist/{st,mt}/ subdir found — did the rollup build run?"
  );
  process.exit(1);
}

// Use node's native cpSync instead of the `cpr` binary so this script runs
// correctly regardless of how it's invoked (`pnpm run build-types`, `node
// ./scripts/build-types.js`, an editor task runner, etc.). cpr was a thin
// wrapper around fs.cp; fs.cpSync is the same primitive without the PATH
// dependency.
for (const v of variants) {
  console.log(`[build-types] Copying js/types → dist/${v}`);
  cpSync("js/types", `dist/${v}`, { recursive: true });
}

console.log("[build-types] Running clean.js");
execSync("node clean.js", { stdio: "inherit" });
