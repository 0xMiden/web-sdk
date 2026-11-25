import { describe, expect, it, vi } from "vitest";
import { MidenClient } from "../client.js";

// The node's answers are mocked on `RpcClient`; the resource must route chain reads through it.
const makeClient = ({ endpoint = "https://rpc.devnet.miden.io" } = {}) => {
  const rpc = {
    getBlockHeaderByNumber: vi.fn(async () => "header"),
    getBlockHeaderWithProof: vi.fn(async () => ({
      header: () => "header-3",
      mmrProof: () => "proof-3",
    })),
    getNullifierCommitHeights: vi.fn(async () => []),
    syncNullifiers: vi.fn(async () => ["update"]),
    free: vi.fn(),
  };
  const wasm = {
    Endpoint: vi.fn(function (url) {
      this.url = url;
    }),
    RpcClient: vi.fn(function () {
      return rpc;
    }),
    Word: { fromHex: vi.fn((hex) => ({ hex, toHex: () => hex })) },
  };
  const inner = { endpoint: vi.fn(() => endpoint), terminate: vi.fn() };
  const client = new MidenClient(inner, async () => wasm, null);
  return { client, rpc, wasm };
};

describe("MidenClient.chain", () => {
  it("reads the latest or a numbered block header without the proof", async () => {
    const { client, rpc, wasm } = makeClient();
    await expect(client.chain.getBlockHeader()).resolves.toBe("header");
    await expect(client.chain.getBlockHeader(7)).resolves.toBe("header");
    expect(rpc.getBlockHeaderByNumber).toHaveBeenNthCalledWith(
      1,
      undefined,
      false
    );
    expect(rpc.getBlockHeaderByNumber).toHaveBeenNthCalledWith(2, 7, false);
    expect(wasm.Endpoint).toHaveBeenCalledWith("https://rpc.devnet.miden.io");
    expect(wasm.RpcClient).toHaveBeenCalledTimes(1);
  });

  it("returns the header with its MMR proof", async () => {
    const { client, rpc } = makeClient();
    await expect(client.chain.getBlockHeaderWithProof(3)).resolves.toEqual({
      header: "header-3",
      mmrProof: "proof-3",
    });
    expect(rpc.getBlockHeaderWithProof).toHaveBeenCalledWith(3);
  });

  it("maps every requested nullifier to its commit height or null", async () => {
    const { client, rpc } = makeClient();
    const found = {
      nullifier: () => ({ toHex: () => "0xaa" }),
      blockNum: () => 9,
    };
    rpc.getNullifierCommitHeights.mockResolvedValue([found]);
    const heights = await client.chain.getNullifierCommitHeights(
      ["0xaa", "0xbb"],
      {
        blockFrom: 4,
      }
    );
    expect([...heights]).toEqual([
      ["0xaa", 9],
      ["0xbb", null],
    ]);
    const [words, blockFrom] = rpc.getNullifierCommitHeights.mock.calls[0];
    expect(words.map((word) => word.hex)).toEqual(["0xaa", "0xbb"]);
    expect(blockFrom).toBe(4);
  });

  it("starts the nullifier scan at block 0 by default", async () => {
    const { client, rpc } = makeClient();
    await client.chain.getNullifierCommitHeights(["0xaa"]);
    expect(rpc.getNullifierCommitHeights.mock.calls[0][1]).toBe(0);
  });

  it("syncs nullifiers from a plain array of prefixes", async () => {
    const { client, rpc } = makeClient();
    await expect(client.chain.syncNullifiers([1, 2], 3, 4)).resolves.toEqual([
      "update",
    ]);
    expect(rpc.syncNullifiers).toHaveBeenCalledWith(
      Uint16Array.from([1, 2]),
      3,
      4
    );
  });

  it("rejects on a mock client, which has no node", async () => {
    const { client } = makeClient({ endpoint: null });
    await expect(client.chain.getBlockHeader()).rejects.toThrow(/no node/);
  });

  it("rejects after terminate and frees the RPC client", async () => {
    const { client, rpc } = makeClient();
    await client.chain.getBlockHeader();
    client.terminate();
    expect(rpc.free).toHaveBeenCalled();
    await expect(client.chain.getBlockHeader()).rejects.toThrow();
  });
});
