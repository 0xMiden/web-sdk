// @ts-nocheck
// Node-only guard: the `node` export entry (js/node-index.js) must re-export
// every public class the napi module exposes. ESM can't re-export a native
// addon's members dynamically, so the entry lists them by hand; this test fails
// if the two drift. node-index.js loads the native addon on import, so the
// imports are done lazily in the test body (only the `nodejs` project runs it).
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
