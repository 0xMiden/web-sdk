import { describe, it, expect } from "vitest";
import {
  assertAnchorValueUsable,
  resolveTransactionRequest,
} from "../../utils/transactions";

describe("assertAnchorValueUsable", () => {
  // Shared by useTransaction and usePreview, so testing it directly covers
  // both call sites. The web-client package has its own copy of this guard
  // with its own tests; the two are intentionally duplicated across packages.
  it.each([
    ["null", null],
    ["false", false],
    ["empty string", ""],
    ["zero", 0],
    ["bigint zero", 0n],
    ["NaN", NaN],
  ])("rejects %s", (_label, value) => {
    expect(() => assertAnchorValueUsable({ anchor: value })).toThrow(
      /await captureAnchor/
    );
  });

  it.each([
    ["an omitted anchor", {}],
    ["an explicitly undefined anchor", { anchor: undefined }],
    ["a present anchor", { anchor: { blockNum: () => 1 } }],
  ])("accepts %s", (_label, options) => {
    expect(() => assertAnchorValueUsable(options)).not.toThrow();
  });
});

describe("resolveTransactionRequest", () => {
  const client = {} as never;

  it("returns a directly supplied request", async () => {
    const request = { id: "req" } as never;
    await expect(resolveTransactionRequest(request, client)).resolves.toBe(
      request
    );
  });

  it("resolves a factory", async () => {
    const request = { id: "req" } as never;
    await expect(
      resolveTransactionRequest(() => Promise.resolve(request), client)
    ).resolves.toBe(request);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("rejects a %s request with a direct-value message", async (_l, value) => {
    await expect(
      resolveTransactionRequest(value as never, client)
    ).rejects.toThrow("a transaction request is required");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("rejects a factory resolving to %s", async (_label, value) => {
    await expect(
      resolveTransactionRequest(() => Promise.resolve(value) as never, client)
    ).rejects.toThrow("the transaction request factory returned");
  });
});
