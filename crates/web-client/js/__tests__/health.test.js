import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MidenClient } from "../client.js";

// `RpcClient.getStatus` is mocked: each test sets what the node answers, or the
// error a request to it rejects with, through `rpc.getStatus`.
const status = (overrides = {}) => ({
  version: "0.18.2",
  chainTip: 120,
  genesisCommitment: { toHex: () => "0xabc" },
  blockProducer: {
    version: "0.18.2",
    status: "connected",
    chainTip: 119,
    mempoolStats: {
      unbatchedTransactions: 3n,
      proposedBatches: 2n,
      provenBatches: 1n,
    },
  },
  ...overrides,
});

const makeClient = ({ endpoint = "https://rpc.devnet.miden.io" } = {}) => {
  const rpc = { getStatus: vi.fn(async () => status()) };
  const wasm = {
    Endpoint: vi.fn(function (url) {
      this.url = url;
    }),
    RpcClient: vi.fn(function () {
      return rpc;
    }),
  };
  const inner = { endpoint: vi.fn(() => endpoint), terminate: vi.fn() };
  const client = new MidenClient(inner, async () => wasm, null);
  return { client, rpc, wasm };
};

describe("MidenClient.checkHealth", () => {
  it("reports a reachable node with its full status", async () => {
    const { client, wasm } = makeClient();
    await expect(client.checkHealth()).resolves.toEqual({
      reachable: true,
      version: "0.18.2",
      chainTip: 120,
      genesisCommitment: "0xabc",
      blockProducer: {
        version: "0.18.2",
        status: "connected",
        chainTip: 119,
        mempoolStats: {
          unbatchedTransactions: 3,
          proposedBatches: 2,
          provenBatches: 1,
        },
      },
    });
    expect(wasm.Endpoint).toHaveBeenCalledWith("https://rpc.devnet.miden.io");
  });

  it("leaves out what the node does not report", async () => {
    const { client, rpc } = makeClient();
    rpc.getStatus.mockResolvedValue(
      status({ genesisCommitment: undefined, blockProducer: undefined })
    );
    await expect(client.checkHealth()).resolves.toEqual({
      reachable: true,
      version: "0.18.2",
      chainTip: 120,
    });
  });

  it("resolves an unreachable node to a result instead of throwing", async () => {
    const { client, rpc } = makeClient();
    rpc.getStatus.mockRejectedValue(new Error("failed to get node status"));
    await expect(client.checkHealth()).resolves.toEqual({
      reachable: false,
      error: "failed to get node status",
    });
  });

  it("reports a mock client, which has no node, as unreachable", async () => {
    const { client, wasm } = makeClient({ endpoint: undefined });
    const result = await client.checkHealth();
    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(/no node/);
    expect(wasm.RpcClient).not.toHaveBeenCalled();
  });

  it("reuses one RpcClient across checks", async () => {
    const { client, wasm, rpc } = makeClient();
    await client.checkHealth();
    await client.checkHealth();
    expect(wasm.RpcClient).toHaveBeenCalledTimes(1);
    expect(rpc.getStatus).toHaveBeenCalledTimes(2);
  });
});

describe("MidenClient.monitorHealth", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires onChange for the first result and then only when the state changes", async () => {
    const { client, rpc } = makeClient();
    const onChange = vi.fn();
    const stop = client.monitorHealth({ intervalMs: 1000, onChange });

    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].reachable).toBe(true);

    // A new chain tip alone is not a change of state.
    rpc.getStatus.mockResolvedValue(status({ chainTip: 121 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(rpc.getStatus).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);

    rpc.getStatus.mockRejectedValue(new Error("down"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0]).toEqual({
      reachable: false,
      error: "down",
    });

    rpc.getStatus.mockRejectedValue(new Error("still down"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(2);

    rpc.getStatus.mockResolvedValue(
      status({
        blockProducer: { ...status().blockProducer, status: "unhealthy" },
      })
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange.mock.calls[2][0].blockProducer.status).toBe("unhealthy");

    rpc.getStatus.mockResolvedValue(status());
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(4);
    stop();
  });

  it("stop() ends the checks", async () => {
    const { client, rpc } = makeClient();
    const stop = client.monitorHealth({ intervalMs: 1000, onChange: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(rpc.getStatus).toHaveBeenCalledTimes(1);
  });

  it("terminate() ends the checks and drops an in-flight result", async () => {
    const { client, rpc } = makeClient();
    const onChange = vi.fn();
    let answer;
    rpc.getStatus.mockImplementation(
      () => new Promise((resolve) => (answer = resolve))
    );
    client.monitorHealth({ intervalMs: 1000, onChange });
    await vi.advanceTimersByTimeAsync(0);
    client.terminate();
    answer(status());
    await vi.advanceTimersByTimeAsync(5000);
    expect(onChange).not.toHaveBeenCalled();
    expect(rpc.getStatus).toHaveBeenCalledTimes(1);
  });

  it("does not start a check before the previous one settles", async () => {
    const { client, rpc } = makeClient();
    rpc.getStatus.mockImplementation(() => new Promise(() => {}));
    const stop = client.monitorHealth({ intervalMs: 10, onChange: vi.fn() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(rpc.getStatus).toHaveBeenCalledTimes(1);
    stop();
  });

  it("rejects invalid options", () => {
    const { client } = makeClient();
    expect(() =>
      client.monitorHealth({ intervalMs: 0, onChange() {} })
    ).toThrow(TypeError);
    expect(() => client.monitorHealth({ intervalMs: 1000 })).toThrow(TypeError);
  });

  it("throws on a terminated client", () => {
    const { client } = makeClient();
    client.terminate();
    expect(() =>
      client.monitorHealth({ intervalMs: 1000, onChange() {} })
    ).toThrow("Client terminated");
  });
});
