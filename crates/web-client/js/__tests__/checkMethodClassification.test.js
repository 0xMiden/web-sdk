import { describe, it, expect } from "vitest";
import {
  extractWasmMethods,
  extractWasmFunctions,
  extractClassifications,
  extractExplicitMethods,
  computeUnclassified,
  computeUnknownClassified,
  allowedUnclassified,
} from "../../scripts/check-method-classification.js";

// A minimal stand-in for the wasm-bindgen `.d.ts`: a WebClient class with a
// couple of methods (instance + static) plus module-level free functions in
// both the direct and the aliased export form that wasm-bindgen emits.
const WASM_DTS = `
export class WebClient {
  free(): void;
  createClient(rpcUrl?: string): Promise<any>;
  newAccount(account: any, overwrite: boolean): Promise<any>;
  getAccounts(): Promise<any>;
  static buildSwapTag(a: any): any;
}
export function importStore(store_name: string, store_dump: string): Promise<void>;
declare function exportStore2(store_name: string): Promise<any>;
export { exportStore2 as exportStore };
`;

const INDEX_JS = `
const SYNC_METHODS = new Set([
  "buildSwapTag",
]);
const WRITE_METHODS = new Set([
  "newAccount",
]);
const READ_METHODS = new Set([
  "getAccounts",
  "exportStore",
]);

class WebClient {
  async newWallet() {}
  terminate() {}
}
class MockWebClient extends WebClient {
  async syncState() {}
}
`;

describe("check-method-classification extractors", () => {
  it("extracts WASM WebClient methods (instance and static)", () => {
    const methods = extractWasmMethods(WASM_DTS);
    expect(methods.has("createClient")).toBe(true);
    expect(methods.has("newAccount")).toBe(true);
    expect(methods.has("getAccounts")).toBe(true);
    expect(methods.has("buildSwapTag")).toBe(true);
    // Free functions are not class methods.
    expect(methods.has("importStore")).toBe(false);
    expect(methods.has("exportStore")).toBe(false);
  });

  it("extracts module-level free functions, including aliased exports", () => {
    const fns = extractWasmFunctions(WASM_DTS);
    expect(fns.has("importStore")).toBe(true);
    // `export { exportStore2 as exportStore }`: the PUBLIC name is recorded.
    expect(fns.has("exportStore")).toBe(true);
    // Class methods are not free functions.
    expect(fns.has("newAccount")).toBe(false);
  });

  it("parses the three classification sets from index.js", () => {
    const sets = extractClassifications(INDEX_JS);
    expect([...sets.syncMethods]).toEqual(["buildSwapTag"]);
    expect([...sets.writeMethods]).toEqual(["newAccount"]);
    expect([...sets.readMethods].sort()).toEqual([
      "exportStore",
      "getAccounts",
    ]);
  });

  it("extracts explicit JS wrapper methods from WebClient and MockWebClient", () => {
    const explicit = extractExplicitMethods(INDEX_JS);
    expect(explicit.has("newWallet")).toBe(true);
    expect(explicit.has("terminate")).toBe(true);
    expect(explicit.has("syncState")).toBe(true);
  });
});

describe("check-method-classification forward check", () => {
  it("passes when every WASM method is classified or allow-listed", () => {
    const wasmMethods = extractWasmMethods(WASM_DTS);
    const sets = extractClassifications(INDEX_JS);
    const classified = new Set([
      ...sets.syncMethods,
      ...sets.writeMethods,
      ...sets.readMethods,
    ]);
    // `createClient` and `free` are covered by the allow-list.
    const unclassified = computeUnclassified(
      wasmMethods,
      classified,
      allowedUnclassified
    );
    expect(unclassified).toEqual([]);
  });

  it("flags a WASM method that is neither classified nor allow-listed", () => {
    const wasmMethods = new Set(["newAccount", "brandNewWriteMethod"]);
    const classified = new Set(["newAccount"]);
    const unclassified = computeUnclassified(
      wasmMethods,
      classified,
      allowedUnclassified
    );
    expect(unclassified).toEqual(["brandNewWriteMethod"]);
  });
});

describe("check-method-classification reverse check", () => {
  it("passes when every classified name maps to a real WASM export", () => {
    const wasmMethods = extractWasmMethods(WASM_DTS);
    const wasmFunctions = extractWasmFunctions(WASM_DTS);
    const validExports = new Set([...wasmMethods, ...wasmFunctions]);
    const sets = extractClassifications(INDEX_JS);
    // exportStore is a free function, buildSwapTag a static method (both valid).
    expect(computeUnknownClassified(sets, validExports)).toEqual([]);
  });

  it("flags a classified name that matches no WASM export (dead entry)", () => {
    const wasmMethods = extractWasmMethods(WASM_DTS);
    const wasmFunctions = extractWasmFunctions(WASM_DTS);
    const validExports = new Set([...wasmMethods, ...wasmFunctions]);
    const sets = {
      syncMethods: new Set(["buildSwapTag", "setDebugMode"]),
      writeMethods: new Set(["newAccount", "forceImportStore"]),
      readMethods: new Set(["getAccounts", "exportStore"]),
    };
    expect(computeUnknownClassified(sets, validExports).sort()).toEqual([
      "forceImportStore",
      "setDebugMode",
    ]);
  });
});
