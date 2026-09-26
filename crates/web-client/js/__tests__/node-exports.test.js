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

// napi rejects a typed array where it expects `Vec<u32>`; the browser build
// accepts one. The Node build has to accept it as well.
describe("Node block number normalization", () => {
  class TransactionRequestBuilder {
    withBlockNumbers(blockNumbers) {
      if (!Array.isArray(blockNumbers)) {
        throw new TypeError("napi expects a plain array");
      }
      this.received = blockNumbers;
      return this;
    }
  }
  createSdkWrapper({ TransactionRequestBuilder });

  it("passes a Uint32Array to napi as a plain array", () => {
    const builder = new TransactionRequestBuilder();
    builder.withBlockNumbers(new Uint32Array([7, 3]));
    expect(builder.received).toEqual([7, 3]);
  });

  it("passes a plain array through", () => {
    const builder = new TransactionRequestBuilder();
    expect(builder.withBlockNumbers([5])).toBe(builder);
    expect(builder.received).toEqual([5]);
  });
});
