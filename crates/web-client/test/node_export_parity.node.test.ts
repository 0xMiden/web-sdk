// @ts-nocheck
// Node-only guard: the `node` export entry (js/node-index.js) must re-export
// every public class the napi module exposes. The browser entry gets full
// coverage for free via a generated `export *`, but ESM can't dynamically
// re-export a native addon's members, so node-index.js lists each name by hand.
// This test fails the moment the two drift — e.g. a new WASM class is added but
// nobody adds it to node-index.js — which is exactly the regression that left
// `BasicFungibleFaucetComponent` (and ~70 other types) unimportable from
// `@miden-sdk/miden-sdk` under the `node` condition, breaking @miden-sdk/react.
//
// node-index.js initializes the native module on import, so both imports are
// done lazily inside the test body (this file is only executed by the `nodejs`
// project; other projects never load the native addon).
import { test, expect } from "./test-setup";

// napi exports the node entry intentionally surfaces under a different name or
// shape than the raw class:
//   - WebClient: exposed as the wrapped `WasmWebClient`.
const INTENTIONALLY_REMAPPED = new Set(["WebClient"]);

test("node entry re-exports every public napi class", async () => {
  const { loadNodeSdk } = await import("./test-setup");
  const nodeEntry = await import("../js/node-index.js");

  const napi = loadNodeSdk();
  const required = Object.keys(napi)
    .filter((name) => !INTENTIONALLY_REMAPPED.has(name))
    .sort();

  // Every public napi export must resolve to a defined value on the node entry.
  const missing = required.filter((name) => nodeEntry[name] === undefined);

  expect(missing).toEqual([]);
});

// JS-layer exports the browser entry provides that are NOT napi classes, so they
// aren't covered by the napi sweep above. These are imported by @miden-sdk/react
// (notably `useCompile`), so a regression here breaks React under the `node`
// export condition just like a missing WASM class would.
test("node entry exports the cross-platform JS helpers react needs", async () => {
  const nodeEntry = await import("../js/node-index.js");
  for (const name of ["CompilerResource", "getWasmOrThrow"]) {
    expect(nodeEntry[name], `node-index.js must export ${name}`).toBeDefined();
  }
});
