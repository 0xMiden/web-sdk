import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// The JSDoc block that directly precedes `anchor`.
function docBefore(source, anchor) {
  const at = source.indexOf(anchor);
  expect(at, `${anchor} not found`).toBeGreaterThan(-1);
  return source.slice(source.lastIndexOf("/**", at), at);
}

const REPLACEMENT = /storeName/;

describe("raw store dump deprecation", () => {
  it.each([
    ["exportStore", "export declare function exportStore("],
    ["importStore", "export declare function importStore("],
  ])(
    "%s is @deprecated in the declarations and names its replacement",
    (_n, anchor) => {
      const doc = docBefore(read("../types/api-types.d.ts"), anchor);
      expect(doc).toMatch(/@deprecated/);
      expect(doc).toMatch(REPLACEMENT);
    }
  );

  it.each([
    ["useExportStore", "export function useExportStore("],
    ["useImportStore", "export function useImportStore("],
  ])("%s is @deprecated and names its replacement", (name, anchor) => {
    const source = read(`../../../../packages/react-sdk/src/hooks/${name}.ts`);
    const doc = docBefore(source, anchor);
    expect(doc).toMatch(/@deprecated/);
    expect(doc).toMatch(REPLACEMENT);
  });

  it.each([
    ["export.rs", "pub async fn export_store("],
    ["import.rs", "pub async fn import_store("],
  ])("%s marks the wasm function deprecated", (file, anchor) => {
    const source = read(`../../src/${file}`);
    const head = source.slice(0, source.indexOf(anchor));
    expect(head.slice(head.lastIndexOf("///"))).toMatch(/deprecated/i);
  });
});
