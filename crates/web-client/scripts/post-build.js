#!/usr/bin/env node
// Post-build step that prepares dist/ for `attw` / `publint` compliance:
//
// 1. Rewrites extensionless relative imports in dist/*.d.ts to use explicit
//    `.js` extensions. TypeScript's Node16/NodeNext module resolution
//    requires explicit extensions on relative specifiers; without this,
//    attw reports `InternalResolutionError` for the published types.
//
// 2. Emits a `lazy/package.json` shim at the package root so that node10
//    module resolution (which doesn't read the `exports` map) can still
//    resolve `@miden-sdk/miden-sdk/lazy` against the published
//    `dist/index.js` / `dist/index.d.ts` artifacts. attw treats the missing
//    fallback as `NoResolution` under the node10 column.
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
    // Match relative specifiers in three forms used by the hand-authored
    // declaration files in `js/types/`:
    //   1. `from "./foo"` / `from "../foo"`         (static import/re-export)
    //   2. `import("./foo")`                         (dynamic import in type position)
    //   3. `import("./foo")` (with whitespace)       (same)
    // For each, append `.js` so Node16 type resolution finds the sibling
    // `.d.ts` (TS resolves `./foo.js` -> `./foo.d.ts` automatically).
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

function writeLazyShim() {
  const lazyDir = path.resolve(__dirname, "..", "lazy");
  fs.mkdirSync(lazyDir, { recursive: true });
  const shim = {
    main: "../dist/index.js",
    types: "../dist/index.d.ts",
  };
  fs.writeFileSync(
    path.join(lazyDir, "package.json"),
    `${JSON.stringify(shim, null, 2)}\n`,
  );
  console.log("[post-build] Wrote lazy/package.json shim");
}

if (!fs.existsSync(distDir)) {
  console.error(`[post-build] dist directory not found at ${distDir}`);
  process.exit(1);
}

rewriteDtsImports(distDir);
writeLazyShim();
