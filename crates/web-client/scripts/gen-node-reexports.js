#!/usr/bin/env node

/**
 * Generates the `_reexport(...)` block in `js/node-index.js` from the napi
 * module's actual exports, so the Node entry stays in lockstep with the native
 * surface without a hand-maintained list.
 *
 * The Node entry can't `export *` from a native addon (ESM needs static named
 * exports), so every public napi class is listed as `export const X =
 * _reexport("X")`. This script writes those lines into the
 * `<generated:napi-reexports>` marker region.
 *
 *   node scripts/gen-node-reexports.js          # rewrite the region
 *   node scripts/gen-node-reexports.js --check   # fail if the region is stale
 *
 * Requires the napi binary to be loadable (set MIDEN_MODULE_PATH, or build it
 * into target/release). CI runs `--check` in the job that builds it.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { loadNativeModule } from "../js/node/loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, "../js/node-index.js");
const START = "// <generated:napi-reexports>";
const END = "// </generated:napi-reexports>";

// napi exports the Node entry surfaces manually (so they are NOT generated):
//   - WebClient:   re-exported as the wrapped `WasmWebClient`.
//   - AccountType: shadowed by a plain-JS enum constant.
//   - AuthScheme:  shadowed by a plain-JS enum constant (the napi class is
//                  re-exported by hand as `AuthSchemeNative`).
const MANUAL = new Set(["WebClient", "AccountType", "AuthScheme"]);

async function buildFile() {
  const napi = loadNativeModule();
  const names = Object.keys(napi)
    .filter((name) => !MANUAL.has(name))
    .sort();
  const block = names
    .map(
      (name) => `export const ${name} = /* @__PURE__ */ _reexport("${name}");`
    )
    .join("\n");

  const src = await readFile(FILE, "utf8");
  const startIdx = src.indexOf(START);
  const endIdx = src.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `Could not find the ${START} ... ${END} markers in ${FILE}`
    );
  }
  const next =
    src.slice(0, startIdx + START.length) +
    "\n" +
    block +
    "\n" +
    src.slice(endIdx);

  const prettierConfig = (await prettier.resolveConfig(FILE)) ?? {};
  const formatted = await prettier.format(next, {
    ...prettierConfig,
    filepath: FILE,
  });
  return { src, formatted, count: names.length };
}

const check = process.argv.includes("--check");
const { src, formatted, count } = await buildFile();

if (check) {
  if (formatted !== src) {
    console.error(
      "❌ js/node-index.js is out of sync with the napi surface.\n" +
        "   Run `pnpm --filter @miden-sdk/miden-sdk gen:node-reexports` and commit the result."
    );
    process.exit(1);
  }
  console.log(
    `✓ node-index.js re-exports are up to date (${count} napi classes).`
  );
} else {
  await writeFile(FILE, formatted);
  console.log(`✓ Wrote ${count} napi re-exports into js/node-index.js.`);
}
