import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// These exports are JS polyfills and must work independently of native exports.
vi.mock("../node/loader.js", () => ({ loadNativeModule: () => ({}) }));

import * as nodeIndex from "../node-index.js";
import { NODE_ARRAY_TYPES } from "../node/napi-compat.js";

// The browser build gets its array containers from this macro, so it is the
// list the Node entry has to match.
const declaredArrays = [
  ...readFileSync(new URL("../../src/models/mod.rs", import.meta.url), "utf8")
    .match(/declare_js_miden_arrays!\s*\{([^}]*)\}/)[1]
    .matchAll(/->\s*(\w+)/g),
]
  .map((match) => match[1])
  .sort();

describe("Node array exports", () => {
  it("names every array declared by declare_js_miden_arrays!", () => {
    expect([...NODE_ARRAY_TYPES].sort()).toEqual(declaredArrays);
  });

  it.each(declaredArrays)("exports a usable %s constructor", (name) => {
    const ArrayType = nodeIndex[name];
    expect(ArrayType).toBeTypeOf("function");
    expect(nodeIndex.MidenArrays[name]).toBe(ArrayType);
    expect(new ArrayType()).toHaveLength(0);
    expect(new ArrayType([])).toHaveLength(0);
    const item = {};
    const items = new ArrayType([item]);

    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0]).toBe(item);
    expect(items.get(0)).toBe(item);
  });
});
