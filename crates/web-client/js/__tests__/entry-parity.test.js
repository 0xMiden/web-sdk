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

    // Only helpers implemented in JS here: the rest come from the WASM module,
    // which each entry pulls in its own way. Subdirectories count, so a helper
    // added under resources/ or node/ is not silently exempt.
    const implemented = new Set();
    const walk = (dir) => {
      for (const entry of readdirSync(`${jsDir}${dir}`, {
        withFileTypes: true,
      })) {
        const path = `${dir}${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "workers")
            walk(`${path}/`);
          continue;
        }
        if (!entry.name.endsWith(".js") || entry.name.endsWith("index.js"))
          continue;
        for (const name of exportedNames(read(path))) implemented.add(name);
      }
    };
    walk("");

    const browser = exportedNames(read("index.js"));
    const node = exportedNames(read("node-index.js"));

    // Symmetric, so browser-only and node-only are both caught: either entry
    // exporting a helper obliges the other, since they share one .d.ts.
    // A helper neither entry exports is a different defect (a declaration no
    // consumer can import) and is tracked separately in #388.
    const missing = declared
      .filter((name) => implemented.has(name))
      .filter((name) => browser.has(name) || node.has(name))
      .flatMap((name) => [
        browser.has(name) ? null : `browser:${name}`,
        node.has(name) ? null : `node:${name}`,
      ])
      .filter(Boolean);

    expect(missing).toEqual([]);
  });
});
