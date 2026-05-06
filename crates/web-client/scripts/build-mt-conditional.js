#!/usr/bin/env node
// Conditionally run `pnpm run build-mt`. Skipped when MIDEN_FAST_BUILD=true.
//
// MIDEN_FAST_BUILD already conveys "PR-CI fast path, not the canonical
// release artifact" semantics (see test.yml's build-web-client-dist-folder
// for the rationale — it picks the release-fast cargo profile and skips
// wasm-opt). Coupling MT-skip to the same flag keeps PR CI from doubling
// the WASM build time on every push, while release CI (which doesn't set
// the flag) builds both ST and MT for the published artifact.
//
// To opt-out for local iteration on the MT path: `MIDEN_FAST_BUILD=`
// (unset) or `MIDEN_FAST_BUILD=false`.

import { execSync } from "node:child_process";

if (process.env.MIDEN_FAST_BUILD === "true") {
  console.log(
    "[build-mt-conditional] Skipping MT build (MIDEN_FAST_BUILD=true)"
  );
  process.exit(0);
}

console.log("[build-mt-conditional] Running MT build");
try {
  execSync("pnpm run build-mt", { stdio: "inherit" });
} catch (err) {
  process.exit(err.status ?? 1);
}
