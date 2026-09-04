import { describe, it, expect } from "vitest";
import { normalizeArg } from "../node/napi-compat.js";

describe("normalizeArg (Node napi-compat)", () => {
  it("preserves Buffer so deserialize/JsBytes keep a backing store", () => {
    const buf = Buffer.from([1, 2, 3]);
    const out = normalizeArg(buf);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out).toBe(buf);
    expect([...out]).toEqual([1, 2, 3]);
  });

  it("converts Uint8Array to Buffer (not a plain array)", () => {
    const u8 = new Uint8Array([4, 5, 6]);
    const out = normalizeArg(u8);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(Array.isArray(out)).toBe(false);
    expect([...out]).toEqual([4, 5, 6]);
  });

  it("copies a Uint8Array view without including unrelated buffer bytes", () => {
    const backing = new Uint8Array([0, 10, 20, 30, 40]);
    const view = backing.subarray(1, 4);
    const out = normalizeArg(view);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect([...out]).toEqual([10, 20, 30]);
  });

  it("still converts BigUint64Array / BigInt64Array to plain arrays", () => {
    expect(normalizeArg(new BigUint64Array([1n, 2n]))).toEqual([1n, 2n]);
    expect(normalizeArg(new BigInt64Array([-1n, 2n]))).toEqual([-1n, 2n]);
  });

  it("passes through unrelated values unchanged", () => {
    expect(normalizeArg(42)).toBe(42);
    expect(normalizeArg("x")).toBe("x");
    expect(normalizeArg(null)).toBe(null);
  });
});
