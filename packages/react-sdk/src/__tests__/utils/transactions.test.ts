import { describe, it, expect } from "vitest";
import { resolveTransactionRequest } from "../../utils/transactions";

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
