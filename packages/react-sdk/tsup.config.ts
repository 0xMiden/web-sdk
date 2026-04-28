import { defineConfig } from "tsup";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Post-build rewrite: swap every `@miden-sdk/miden-sdk/lazy` import in the
 * eager bundle (`index.mjs`) to `@miden-sdk/miden-sdk` (the default entry).
 * Consumer bundlers resolve the rewritten string to the SDK's eager variant,
 * which initializes WASM via TLA on import.
 *
 * The React SDK's source tree always imports from the `/lazy` subpath, so the
 * lazy build (`lazy.mjs`) ships unchanged. We rewrite only the eager bundle
 * at the emitted-file level, which is more reliable than an esbuild
 * `onResolve` hook — tsup's default externalization from `peerDependencies`
 * happens before our plugin gets a chance to change the import path.
 */
function rewriteEagerBundles(distDir: string): void {
  for (const file of ["index.mjs"]) {
    const path = join(distDir, file);
    const before = readFileSync(path, "utf8");
    const after = before.replace(
      /@miden-sdk\/miden-sdk\/lazy/g,
      "@miden-sdk/miden-sdk"
    );
    if (after === before) continue;
    writeFileSync(path, after);
  }
}

export default defineConfig([
  // Eager variant — default entry (`@miden-sdk/react`).
  //
  // Source imports `@miden-sdk/miden-sdk/lazy`; `onSuccess` rewrites those
  // to `@miden-sdk/miden-sdk` after emit, so consumer bundlers resolve
  // against the SDK's eager default.
  //
  // ESM-only: `@miden-sdk/miden-sdk` is `"type": "module"` and exports only
  // `import` conditions, so a CJS variant of this package would crash with
  // `ERR_REQUIRE_ESM` at runtime under Node-CJS. Modern targets (Vite,
  // webpack 5, Next.js 13+, Remix 2+) all handle ESM natively.
  //
  // We force the `.mjs` extension explicitly via `outExtension` so the
  // emitted file name stays stable regardless of the package.json `type`
  // field (tsup defaults to `.js` for ESM under `"type": "module"`).
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    dts: true,
    clean: true,
    onSuccess: async () => {
      rewriteEagerBundles("dist");
    },
  },
  // Lazy variant — subpath entry (`@miden-sdk/react/lazy`).
  //
  // No rewrite; imports keep `@miden-sdk/miden-sdk/lazy` so consumer
  // bundlers resolve them against the SDK's lazy subpath (no TLA).
  // Required for Capacitor hosts, Next.js SSR, and any environment that
  // can't tolerate top-level await at SDK module evaluation.
  {
    entry: { lazy: "src/index.ts" },
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    dts: true,
    clean: false,
  },
]);
