import { defineConfig } from "tsup";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Post-build rewrite: change every bare `@miden-sdk/miden-sdk` import in
 * the named bundle to a variant-specific subpath. The React SDK's source
 * tree always imports the bare specifier (the eager-ST default); each
 * emitted variant gets the corresponding SDK subpath substituted at the
 * file level after emit. This is more reliable than an esbuild
 * `onResolve` hook — tsup's default externalization from
 * `peerDependencies` happens before our plugin gets a chance to change
 * the import path.
 *
 * Only the exact quoted specifier `"@miden-sdk/miden-sdk"` is rewritten,
 * so subpath imports (if any ever appear in src) are left untouched.
 *
 * Mapping per variant:
 *   index.mjs    → `@miden-sdk/miden-sdk`         (eager + ST, no rewrite needed)
 *   lazy.mjs     → `@miden-sdk/miden-sdk/lazy`    (lazy + ST)
 *   mt.mjs       → `@miden-sdk/miden-sdk/mt`      (eager + MT)
 *   mt/lazy.mjs  → `@miden-sdk/miden-sdk/mt/lazy` (lazy + MT)
 */
function rewriteSdkImport(distFile: string, replacement: string): void {
  const path = join("dist", distFile);
  if (!existsSync(path)) return;
  const before = readFileSync(path, "utf8");
  const after = before
    .replace(/"@miden-sdk\/miden-sdk"/g, `"${replacement}"`)
    .replace(/'@miden-sdk\/miden-sdk'/g, `'${replacement}'`);
  if (after === before) {
    throw new Error(
      `rewriteSdkImport: no bare @miden-sdk/miden-sdk import found in ${path} — ` +
        `the variant would silently ship the wrong SDK build. Did the source ` +
        `import specifier change?`
    );
  }
  writeFileSync(path, after);
}

export default defineConfig([
  // Eager + ST — default entry (`@miden-sdk/react`).
  //
  // Source imports the bare `@miden-sdk/miden-sdk` (eager-ST), which is
  // exactly what this variant wants — no rewrite.
  //
  // ESM-only: `@miden-sdk/miden-sdk` is `"type": "module"` and exports only
  // `import` conditions, so a CJS variant of this package would crash with
  // `ERR_REQUIRE_ESM` at runtime under Node-CJS. Modern targets (Vite,
  // webpack 5, Next.js 13+, Remix 2+) all handle ESM natively.
  //
  // We force the `.mjs` extension explicitly via `outExtension` so the
  // emitted file name stays stable regardless of the package.json `type`
  // field (tsup defaults to `.js` for ESM under `"type": "module"`).
  //
  // `clean: true` only on this first config so subsequent variants build
  // into the same `dist/` without wiping each other.
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    dts: true,
    clean: true,
  },
  // Lazy + ST — subpath entry (`@miden-sdk/react/lazy`).
  //
  // Rewrites SDK imports to `@miden-sdk/miden-sdk/lazy` so consumer
  // bundlers resolve them against the SDK's lazy-ST subpath (no TLA).
  // Required for Capacitor hosts, Next.js SSR, and any environment that
  // can't tolerate top-level await at SDK module evaluation.
  {
    entry: { lazy: "src/index.ts" },
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    dts: true,
    clean: false,
    onSuccess: async () => {
      rewriteSdkImport("lazy.mjs", "@miden-sdk/miden-sdk/lazy");
    },
  },
  // Eager + MT — subpath entry (`@miden-sdk/react/mt`).
  //
  // Rewrites SDK imports to `@miden-sdk/miden-sdk/mt`. Consumer must run
  // on a cross-origin-isolated page; see the SDK's README for header
  // setup. Multi-threaded proving via wasm-bindgen-rayon is enabled
  // automatically once `initThreadPool(navigator.hardwareConcurrency)`
  // has been awaited (typically at app startup).
  {
    entry: { mt: "src/index.ts" },
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    dts: true,
    clean: false,
    onSuccess: async () => {
      rewriteSdkImport("mt.mjs", "@miden-sdk/miden-sdk/mt");
    },
  },
  // Lazy + MT — subpath entry (`@miden-sdk/react/mt/lazy`).
  //
  // Rewrites SDK imports to `@miden-sdk/miden-sdk/mt/lazy`. The MT lazy
  // path is what dApp authors typically want when they control their
  // server's COOP/COEP headers — no TLA at SDK load (Next.js SSR safe)
  // AND multi-threaded proving once `initThreadPool` is awaited.
  {
    // tsup writes this to `dist/mt/lazy.mjs` (subdir).
    entry: { "mt/lazy": "src/index.ts" },
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    dts: true,
    clean: false,
    onSuccess: async () => {
      rewriteSdkImport("mt/lazy.mjs", "@miden-sdk/miden-sdk/mt/lazy");
    },
  },
]);
