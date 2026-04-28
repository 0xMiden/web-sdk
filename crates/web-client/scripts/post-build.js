#!/usr/bin/env node
// Post-build step that prepares dist/ for `attw` / `publint` compliance.
//
// Rewrites extensionless relative imports in dist/*.d.ts to use explicit
// `.js` extensions. TypeScript's Node16/NodeNext module resolution
// requires explicit extensions on relative specifiers; without this,
// attw reports `InternalResolutionError` for the published types.
//
// The `lazy/package.json` node10 fallback shim is checked into the repo
// at `crates/web-client/lazy/package.json` rather than emitted here; this
// keeps the published artifact set fully visible in source control and
// avoids a script-generated file outside `dist/`.
//
// This file only touches generated output in `dist/`. It does not modify
// any source under `src/` or `js/types/`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "..", "dist");

function rewriteDtsImports(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteDtsImports(full);
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;

    const original = fs.readFileSync(full, "utf8");
    // Match relative specifiers in two forms used by the hand-authored
    // declaration files in `js/types/`:
    //   1. `from "./foo"` / `from "../foo"`         (static import/re-export)
    //   2. `import("./foo")`                         (dynamic import in type position)
    // For each, append `.js` so Node16 type resolution finds the sibling
    // `.d.ts` (TS resolves `./foo.js` -> `./foo.d.ts` automatically).
    //
    // Does not handle bare side-effect imports (import "./foo") — none
    // currently exist in dist/**.d.ts.
    const rewriteSpec = (match, prefix, spec, suffix) => {
      if (/\.[a-zA-Z0-9]+$/.test(spec)) return match; // already has extension
      if (spec.endsWith("/")) return match; // directory specifier, leave alone
      return `${prefix}${spec}.js${suffix}`;
    };
    const updated = original
      .replace(/(from\s+["'])(\.\.?\/[^"']+?)(["'])/g, rewriteSpec)
      .replace(/(import\s*\(\s*["'])(\.\.?\/[^"']+?)(["']\s*\))/g, rewriteSpec);

    if (updated !== original) {
      fs.writeFileSync(full, updated);
      console.log(`[post-build] Rewrote relative imports in ${path.relative(distDir, full)}`);
    }
  }
}

if (!fs.existsSync(distDir)) {
  console.error(`[post-build] dist directory not found at ${distDir}`);
  process.exit(1);
}

rewriteDtsImports(distDir);
