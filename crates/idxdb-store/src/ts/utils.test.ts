import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import { mapOption, logWebStoreError, uint8ArrayToBase64 } from "./utils.js";

describe("mapOption", () => {
  it("applies the function when value is defined", () => {
    expect(mapOption(5, (n) => n * 2)).toBe(10);
  });

  it("returns undefined when value is null", () => {
    expect(mapOption<number, number>(null, (n) => n * 2)).toBeUndefined();
  });

  it("returns undefined when value is undefined", () => {
    expect(mapOption<number, number>(undefined, (n) => n * 2)).toBeUndefined();
  });

  it("treats 0 and empty string as defined", () => {
    expect(mapOption(0, (n) => n + 1)).toBe(1);
    expect(mapOption("", (s) => s.length)).toBe(0);
  });
});

describe("uint8ArrayToBase64", () => {
  it("encodes bytes correctly", () => {
    expect(uint8ArrayToBase64(new Uint8Array([1, 2, 3]))).toBe("AQID");
  });

  it("encodes an empty array to an empty string", () => {
    expect(uint8ArrayToBase64(new Uint8Array([]))).toBe("");
  });
});

describe("logWebStoreError", () => {
  let errorSpy: any;
  let traceSpy: any;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    traceSpy = vi.spyOn(console, "trace").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    traceSpy.mockRestore();
  });

  it("logs and rethrows a Dexie error with context", () => {
    const err = new Dexie.DexieError("OpenError", "DB closed");
    expect(() => logWebStoreError(err, "ctx")).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ctx: Indexdb error")
    );
  });

  it("logs a Dexie error without context", () => {
    const err = new Dexie.DexieError("OpenError", "DB closed");
    expect(() => logWebStoreError(err)).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Indexdb error:/)
    );
  });

  it("logs a Dexie error's stack when present", () => {
    const err = new Dexie.DexieError("OpenError", "DB closed");
    (err as any).stack = "stack-line";
    expect(() => logWebStoreError(err)).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Stacktrace")
    );
  });

  it("recurses into Dexie inner exception", () => {
    const inner = new Error("inner-cause");
    const err = new Dexie.DexieError("OpenError", "outer");
    (err as any).inner = inner;
    expect(() => logWebStoreError(err)).toThrow();
    expect(errorSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it("logs a plain Error with stack", () => {
    const err = new Error("boom");
    expect(() => logWebStoreError(err)).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unexpected error")
    );
  });

  it("logs a plain Error without stack", () => {
    const err = new Error("boom");
    err.stack = undefined;
    expect(() => logWebStoreError(err)).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unexpected error")
    );
  });

  it("logs and rethrows a non-Error value", () => {
    expect(() => logWebStoreError({ thrown: "thing" })).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("non-error value")
    );
    expect(traceSpy).toHaveBeenCalled();
  });
});
