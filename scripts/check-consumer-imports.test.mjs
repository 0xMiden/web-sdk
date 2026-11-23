// Run with `node --test scripts/check-consumer-imports.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectImports, exportNames } from "./check-consumer-imports.mjs";

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "consumer-imports-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

test("exportNames lists named, aliased, declared and star re-exports", (t) => {
  const root = fixture(t, {
    "entry.js": [
      'export { a, b as c } from "./x.js";',
      'export * from "./y.js";',
      "export const k = 1, l = 2;",
      "export function f() {}",
      "export class C {}",
      "const hidden = 1;",
      "export { hidden as renamed };",
    ].join("\n"),
    "x.js":
      "export const a = 1; export const b = 2; export const notReexported = 3;",
    "y.js": "export const fromStar = 1; export default 1;",
  });
  assert.deepEqual(
    [...exportNames(join(root, "entry.js"))].sort(),
    ["C", "c", "a", "f", "fromStar", "k", "l", "renamed"].sort()
  );
});

test("exportNames survives a re-export cycle", (t) => {
  const root = fixture(t, {
    "a.js": 'export * from "./b.js"; export const fromA = 1;',
    "b.js": 'export * from "./a.js"; export const fromB = 1;',
  });
  assert.deepEqual([...exportNames(join(root, "a.js"))].sort(), [
    "fromA",
    "fromB",
  ]);
});

test("collectImports records original names and separates type-only imports", (t) => {
  const root = fixture(t, {
    "one.ts": [
      'import { WasmWebClient as WebClient, MidenClient } from "@miden-sdk/miden-sdk";',
      'import type { AccountId } from "@miden-sdk/miden-sdk";',
      'import { type Note, Word } from "@miden-sdk/miden-sdk/lazy";',
      'export { useMultiSigner } from "@miden-sdk/react";',
      'import { unrelated } from "other-package";',
    ].join("\n"),
  });
  const got = collectImports(
    [join(root, "one.ts")],
    ["@miden-sdk/miden-sdk", "@miden-sdk/react"]
  );
  const sdk = got.get("@miden-sdk/miden-sdk");
  assert.deepEqual([...sdk.values].sort(), ["MidenClient", "WasmWebClient"]);
  assert.deepEqual([...sdk.types].sort(), [
    "AccountId",
    "MidenClient",
    "WasmWebClient",
  ]);
  const lazy = got.get("@miden-sdk/miden-sdk/lazy");
  assert.deepEqual([...lazy.values], ["Word"]);
  assert.deepEqual([...lazy.types].sort(), ["Note", "Word"]);
  assert.deepEqual([...got.get("@miden-sdk/react").values], ["useMultiSigner"]);
  assert.equal(got.has("other-package"), false);
});

test("collectImports records export names bound by awaited dynamic import()", (t) => {
  const root = fixture(t, {
    "two.ts": [
      'import type { AccountId } from "@miden-sdk/miden-sdk";',
      'export type Mode = import("@miden-sdk/miden-sdk").AccountStorageMode;',
      "export async function load(spec: string) {",
      "  const {",
      "    MidenClient: MidenClientClass,",
      '  } = await import("@miden-sdk/miden-sdk");',
      "  const { SigningInputs, AccountBuilder, Poseidon2 } =",
      '    await import("@miden-sdk/miden-sdk");',
      '  const { Word } = await import("@miden-sdk/miden-sdk/lazy");',
      '  const sdk = await import("@miden-sdk/miden-sdk");',
      "  const { fromSpec } = await import(spec);",
      '  const { unrelated } = await import("other-package");',
      "  return [MidenClientClass, SigningInputs, AccountBuilder, Poseidon2, Word, sdk, fromSpec, unrelated];",
      "}",
    ].join("\n"),
  });
  const got = collectImports(
    [join(root, "two.ts")],
    ["@miden-sdk/miden-sdk", "@miden-sdk/react"]
  );
  const sdk = got.get("@miden-sdk/miden-sdk");
  assert.deepEqual([...sdk.values].sort(), [
    "AccountBuilder",
    "MidenClient",
    "Poseidon2",
    "SigningInputs",
  ]);
  assert.deepEqual([...sdk.types].sort(), [
    "AccountBuilder",
    "AccountId",
    "MidenClient",
    "Poseidon2",
    "SigningInputs",
  ]);
  assert.deepEqual([...got.get("@miden-sdk/miden-sdk/lazy").values], ["Word"]);
  assert.equal(got.has("other-package"), false);
});
