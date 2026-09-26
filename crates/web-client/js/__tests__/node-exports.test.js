import { describe, expect, it } from "vitest";

import { createSdkWrapper } from "../node/napi-compat.js";

// napi takes plain JS arrays, but the browser SDK requires typed wrappers, so the
// Node build polyfills each array type. A polyfill that stopped behaving like an
// array would break every cross-platform call site that constructs one.
const sdk = createSdkWrapper({});

describe("Node array polyfills", () => {
  it.each([
    ["FeltArray"],
    ["ForeignAccountArray"],
    ["NoteAndArgsArray"],
    ["OutputNotesArray"],
  ])("exposes a usable %s constructor", (name) => {
    const ArrayType = sdk[name];
    expect(typeof ArrayType).toBe("function");

    const item = {};
    const items = new ArrayType([item]);

    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0]).toBe(item);
    expect(items.get(0)).toBe(item);
  });

  it("starts empty when constructed with no items", () => {
    expect(new sdk.FeltArray()).toHaveLength(0);
    expect(new sdk.FeltArray(null)).toHaveLength(0);
  });
});
