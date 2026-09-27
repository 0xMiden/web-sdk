import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const jsDir = path.dirname(fileURLToPath(import.meta.url));
const entryFiles = ["index.js", "node-index.js"];

/**
 * `buildNetworkNote` is declared in api-types.d.ts and implemented in
 * standalone.js. Both package entry points must re-export it, or TypeScript
 * accepts an import that fails at runtime (#388).
 */
describe("entry exports for buildNetworkNote", () => {
  it.each(entryFiles)("re-exports buildNetworkNote from %s", (file) => {
    const source = fs.readFileSync(path.join(jsDir, "..", file), "utf8");
    expect(source).toMatch(/\bbuildNetworkNote\b/);
    expect(source).toMatch(/export\s*\{[^}]*\bbuildNetworkNote\b[^}]*\}/);
  });
});
