import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The package resolves `.` to js/node-index.js under the "node" condition and
// to the built browser bundle otherwise, while both share one .d.ts. A helper
// exported from only one entry is therefore a promise the other cannot keep:
// the declaration type-checks and the import fails to link at runtime. That
// happened to `isConsumableNow`. node-index.js is hand-maintained, so this
// test derives the rule instead of listing names.
const jsDir = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFileSync(`${jsDir}${file}`, "utf8");

const exportedNames = (source) => {
  const names = new Set();
  for (const [, list] of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of list.split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name) names.add(name);
    }
  }
  for (const [, name] of source.matchAll(
    /export\s+(?:async\s+)?(?:const|function|class)\s+([A-Za-z0-9_$]+)/g
  )) {
    names.add(name);
  }
  return names;
};

describe("entry parity", () => {
  it("re-exports every JS helper from both the browser and node entries", () => {
    const declared = [
      ...read("types/api-types.d.ts").matchAll(
        /export declare function ([A-Za-z0-9_$]+)/g
      ),
    ].map(([, name]) => name);

    // Only helpers implemented in this directory: the rest come from the WASM
    // module, which each entry pulls in its own way.
    const implemented = new Set();
    for (const file of readdirSync(jsDir)) {
      if (!file.endsWith(".js") || file.endsWith("index.js")) continue;
      for (const name of exportedNames(read(file))) implemented.add(name);
    }

    const browser = exportedNames(read("index.js"));
    const node = exportedNames(read("node-index.js"));

    const missing = declared
      .filter((name) => implemented.has(name) && browser.has(name))
      .filter((name) => !node.has(name));

    expect(missing).toEqual([]);
  });
});
