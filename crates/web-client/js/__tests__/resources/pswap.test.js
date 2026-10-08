import { describe, it, expect, vi, beforeEach } from "vitest";
import { PswapResource } from "../../resources/pswap.js";

function makeWasm(overrides = {}) {
  return {
    AccountId: {
      fromHex: vi.fn((hex) => ({ hex, toString: () => hex })),
      fromBech32: vi.fn((b) => ({ bech32: b, toString: () => b })),
    },
    ...overrides,
  };
}

function makeInner(overrides = {}) {
  return {
    getPswapLineages: vi.fn().mockResolvedValue(["lineageA", "lineageB"]),
    getPswapLineagesFor: vi.fn().mockResolvedValue(["lineageA"]),
    getPswapLineage: vi.fn().mockResolvedValue({
      creatorAccountId: vi.fn().mockReturnValue("creatorId"),
      state: vi.fn().mockReturnValue(0),
    }),
    buildPswapCancelByOrder: vi.fn().mockResolvedValue("cancelRequest"),
    ...overrides,
  };
}

function makeClient(overrides = {}) {
  return {
    assertNotTerminated: vi.fn(),
    transactions: {
      submit: vi.fn().mockResolvedValue({
        txId: { toHex: () => "0xtx" },
        result: "submitResult",
      }),
      waitFor: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

describe("PswapResource", () => {
  let inner;
  let client;
  let wasm;
  let getWasm;

  beforeEach(() => {
    inner = makeInner();
    client = makeClient();
    wasm = makeWasm();
    getWasm = vi.fn().mockResolvedValue(wasm);
  });

  function makeResource() {
    return new PswapResource(inner, getWasm, client);
  }

  describe("lineages", () => {
    it("asserts liveness and returns every tracked lineage", async () => {
      const resource = makeResource();
      const result = await resource.lineages();
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.getPswapLineages).toHaveBeenCalledOnce();
      expect(result).toEqual(["lineageA", "lineageB"]);
    });
  });

  describe("lineagesFor", () => {
    it("resolves a hex account ref and filters by creator", async () => {
      const resource = makeResource();
      const result = await resource.lineagesFor("0xcreator");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(wasm.AccountId.fromHex).toHaveBeenCalledWith("0xcreator");
      expect(inner.getPswapLineagesFor).toHaveBeenCalledWith(
        expect.objectContaining({ hex: "0xcreator" })
      );
      expect(result).toEqual(["lineageA"]);
    });

    it("resolves an Account object via its id() method", async () => {
      const accountObj = { id: vi.fn().mockReturnValue("resolvedId") };
      const resource = makeResource();
      await resource.lineagesFor(accountObj);
      expect(accountObj.id).toHaveBeenCalledOnce();
      expect(inner.getPswapLineagesFor).toHaveBeenCalledWith("resolvedId");
    });
  });

  describe("lineage", () => {
    it("stringifies the order id and returns the tracked lineage", async () => {
      const lineage = { creatorAccountId: vi.fn() };
      inner.getPswapLineage.mockResolvedValue(lineage);
      const resource = makeResource();
      const result = await resource.lineage(12345n);
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.getPswapLineage).toHaveBeenCalledWith("12345");
      expect(result).toBe(lineage);
    });

    it("returns null when the order is not tracked", async () => {
      inner.getPswapLineage.mockResolvedValue(undefined);
      const resource = makeResource();
      const result = await resource.lineage("999");
      expect(result).toBeNull();
    });
  });

  describe("cancelByOrder", () => {
    it("throws when no lineage is tracked for the order", async () => {
      inner.getPswapLineage.mockResolvedValue(undefined);
      const resource = makeResource();
      await expect(resource.cancelByOrder({ orderId: 7n })).rejects.toThrow(
        "No PSWAP lineage tracked for order 7"
      );
      expect(inner.buildPswapCancelByOrder).not.toHaveBeenCalled();
    });

    it("rejects a numeric orderId to guard u64 precision", async () => {
      const resource = makeResource();
      // `number` cannot represent a u64 order id above 2^53 without silent
      // precision loss, so it is refused before any lineage lookup.
      await expect(resource.cancelByOrder({ orderId: 42 })).rejects.toThrow(
        /must be a string or bigint/
      );
      expect(inner.getPswapLineage).not.toHaveBeenCalled();
    });

    it("resolves the creator from the lineage, builds, and submits", async () => {
      const resource = makeResource();
      const result = await resource.cancelByOrder({
        orderId: 42n,
        prover: "myProver",
      });
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.getPswapLineage).toHaveBeenCalledWith("42");
      expect(inner.buildPswapCancelByOrder).toHaveBeenCalledWith("42");
      expect(client.transactions.submit).toHaveBeenCalledWith(
        "creatorId",
        "cancelRequest",
        { prover: "myProver" }
      );
      expect(client.transactions.waitFor).not.toHaveBeenCalled();
      expect(result).toEqual({
        txId: expect.objectContaining({ toHex: expect.any(Function) }),
        result: "submitResult",
      });
    });

    it("waits for confirmation when requested, passing the tx hash and timeout", async () => {
      const resource = makeResource();
      await resource.cancelByOrder({
        orderId: 42n,
        waitForConfirmation: true,
        timeout: 5000,
      });
      expect(client.transactions.waitFor).toHaveBeenCalledWith("0xtx", {
        timeout: 5000,
      });
    });
  });
});
