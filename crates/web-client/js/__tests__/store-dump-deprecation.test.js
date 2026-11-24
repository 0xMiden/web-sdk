import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// The JSDoc block that directly precedes `anchor`.
function docBefore(source, anchor) {
  const at = source.indexOf(anchor);
  expect(at, `${anchor} not found`).toBeGreaterThan(-1);
  const end = source.lastIndexOf("*/", at);
  expect(source.slice(end + 2, at).trim(), `${anchor} has no JSDoc`).toBe("");
  const start = source.lastIndexOf("/*", end);
  expect(source.startsWith("/**", start), `${anchor} has no JSDoc`).toBe(true);
  return source.slice(start, end + 2);
}

const REPLACEMENT = /storeName/;

describe("raw store dump deprecation", () => {
  it.each([
    [
      "exportStore",
      "export declare function exportStore(",
      ["accounts.export", "notes.export"],
    ],
    [
      "importStore",
      "export declare function importStore(",
      ["accounts.import", "notes.import"],
    ],
  ])(
    "%s is @deprecated in the declarations and names its replacement",
    (_n, anchor, typed) => {
      const doc = docBefore(read("../types/api-types.d.ts"), anchor);
      expect(doc).toMatch(/@deprecated/);
      expect(doc).toMatch(REPLACEMENT);
      for (const api of typed) expect(doc).toContain(api);
    }
  );

  it.each([
    [
      "useExportStore",
      "export function useExportStore(",
      ["useExportNote", "accounts.export"],
    ],
    [
      "useImportStore",
      "export function useImportStore(",
      ["useImportNote", "useImportAccount"],
    ],
  ])("%s is @deprecated and names its replacement", (name, anchor, typed) => {
    const source = read(`../../../../packages/react-sdk/src/hooks/${name}.ts`);
    const doc = docBefore(source, anchor);
    expect(doc).toMatch(/@deprecated/);
    expect(doc).toMatch(REPLACEMENT);
    for (const api of typed) expect(doc).toContain(api);
  });

  it.each([
    ["export.rs", "pub async fn export_store("],
    ["import.rs", "pub async fn import_store("],
  ])("%s marks the wasm function deprecated", (file, anchor) => {
    const source = read(`../../src/${file}`);
    const head = source.slice(0, source.indexOf(anchor));
    expect(head.slice(-600)).toMatch(/deprecated/i);
  });
});
