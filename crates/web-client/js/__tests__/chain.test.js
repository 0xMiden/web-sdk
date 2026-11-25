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
    Word: {
      fromHex: vi.fn((hex) => ({
        hex,
        toHex: () => hex.toLowerCase(),
        free: vi.fn(),
      })),
    },
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

describe("MidenClient.chain hygiene", () => {
  const update = (hex, block) => ({
    nullifier: vi.fn(() => ({ toHex: () => hex, free: vi.fn() })),
    blockNum: () => block,
    free: vi.fn(),
  });

  it("matches a nullifier whatever the case of the hex the caller passed", async () => {
    const { client, rpc } = makeClient();
    rpc.getNullifierCommitHeights.mockResolvedValue([update("0xaa", 9)]);
    const heights = await client.chain.getNullifierCommitHeights(["0xAA"]);
    expect(heights.get("0xAA")).toBe(9);
  });

  it("never hands a caller's Word to the RPC or frees it", async () => {
    const { client, rpc } = makeClient();
    const word = { toHex: () => "0xaa", free: vi.fn() };
    await client.chain.getNullifierCommitHeights([word]);
    const [words] = rpc.getNullifierCommitHeights.mock.calls[0];
    expect(words[0]).not.toBe(word);
    expect(word.free).not.toHaveBeenCalled();
  });

  it("frees the words it built, unless the RPC already consumed them", async () => {
    const { client, rpc, wasm } = makeClient();
    await client.chain.getNullifierCommitHeights(["0xaa", "0xbb"]);
    const [words] = rpc.getNullifierCommitHeights.mock.calls[0];
    for (const word of words) expect(word.free).toHaveBeenCalledTimes(1);

    wasm.Word.fromHex.mockImplementation((hex) => ({
      hex,
      toHex: () => hex,
      free: vi.fn(),
      __wbg_ptr: 0,
    }));
    await client.chain.getNullifierCommitHeights(["0xcc"]);
    const consumed = rpc.getNullifierCommitHeights.mock.calls[1][0];
    expect(consumed[0].free).not.toHaveBeenCalled();
  });

  it("frees each update and its nullifier word after reading them", async () => {
    const { client, rpc } = makeClient();
    const found = update("0xaa", 9);
    rpc.getNullifierCommitHeights.mockResolvedValue([found]);
    await client.chain.getNullifierCommitHeights(["0xaa"]);
    expect(found.free).toHaveBeenCalledTimes(1);
    expect(found.nullifier.mock.results[0].value.free).toHaveBeenCalledTimes(1);
  });

  it("frees the header-with-proof wrapper after cloning its parts", async () => {
    const { client, rpc } = makeClient();
    const result = {
      header: () => "header-3",
      mmrProof: () => "proof-3",
      free: vi.fn(),
    };
    rpc.getBlockHeaderWithProof.mockResolvedValue(result);
    await client.chain.getBlockHeaderWithProof(3);
    expect(result.free).toHaveBeenCalledTimes(1);
  });

  it.each([[[65536]], [[-1]], [[1.5]], [["1"]], [[Number.NaN]]])(
    "rejects the invalid nullifier prefixes %j before any RPC call",
    async (prefixes) => {
      const { client, rpc, wasm } = makeClient();
      await expect(client.chain.syncNullifiers(prefixes, 0, 1)).rejects.toThrow(
        RangeError
      );
      expect(wasm.RpcClient).not.toHaveBeenCalled();
      expect(rpc.syncNullifiers).not.toHaveBeenCalled();
    }
  );

  it("accepts the 16-bit bounds and an empty list", async () => {
    const { client, rpc } = makeClient();
    await client.chain.syncNullifiers([0, 65535], 0, 1);
    await client.chain.syncNullifiers([], 0, 1);
    expect(rpc.syncNullifiers.mock.calls[0][0]).toEqual(
      Uint16Array.from([0, 65535])
    );
    expect(rpc.syncNullifiers.mock.calls[1][0]).toEqual(new Uint16Array());
  });

  it("keeps the RPC client alive until a read in flight settles", async () => {
    const { client, rpc } = makeClient();
    let release;
    rpc.getBlockHeaderByNumber.mockReturnValue(
      new Promise((resolve) => (release = resolve))
    );
    const pending = client.chain.getBlockHeader();
    await vi.waitFor(() =>
      expect(rpc.getBlockHeaderByNumber).toHaveBeenCalled()
    );
    client.terminate();
    expect(rpc.free).not.toHaveBeenCalled();
    release("header");
    await expect(pending).resolves.toBe("header");
    expect(rpc.free).toHaveBeenCalled();
  });

  it("rejects every read after terminate without calling the RPC", async () => {
    const { client, rpc } = makeClient();
    client.terminate();
    for (const call of [
      () => client.chain.getBlockHeader(),
      () => client.chain.getBlockHeaderWithProof(1),
      () => client.chain.getNullifierCommitHeights(["0xaa"]),
      () => client.chain.syncNullifiers([1], 0, 1),
    ]) {
      await expect(call()).rejects.toThrow(/Client terminated/);
    }
    expect(rpc.getBlockHeaderByNumber).not.toHaveBeenCalled();
  });
});
