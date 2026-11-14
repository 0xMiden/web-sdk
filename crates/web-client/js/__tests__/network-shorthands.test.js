import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// `js/index.js` re-exports the wasm-bindgen surface from "../Cargo.toml",
// which the node test environment cannot parse. The only WASM the tests below
// reach is the export the factories name a client's store with, which the
// stand-in module provides.
vi.mock("../../Cargo.toml", () => ({}));
vi.mock("../wasm.js", () => ({
  default: async () => ({
    resolveStoreName: (_nodeUrl, storeName) => storeName,
  }),
}));

import { MidenClient } from "../index.js";

let savedWebClient;
let savedGetWasm;

beforeEach(() => {
  savedWebClient = MidenClient._WasmWebClient;
  savedGetWasm = MidenClient._getWasmOrThrow;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  MidenClient._WasmWebClient = savedWebClient;
  MidenClient._getWasmOrThrow = savedGetWasm;
  vi.restoreAllMocks();
});

/**
 * Records the arguments of the client factory and of the prover the client is
 * built with. `createClient` receives the RPC URL at index 0 and the note
 * transport URL at index 1.
 */
function captureFactory() {
  const calls = { createClient: [], remoteProver: [], localProver: 0 };
  MidenClient._WasmWebClient = {
    createClient: async (...args) => {
      calls.createClient.push(args);
      return { syncState: async () => {} };
    },
  };
  MidenClient._getWasmOrThrow = async () => ({
    TransactionProver: {
      newRemoteProver: (url) => {
        calls.remoteProver.push(url);
        return {};
      },
      newLocalProver: () => {
        calls.localProver += 1;
        return {};
      },
    },
  });
  return calls;
}

describe("mainnet network shorthands", () => {
  it("createMainnet targets the mainnet RPC, prover and note transport", async () => {
    const calls = captureFactory();

    await MidenClient.createMainnet();

    expect(calls.createClient).toHaveLength(1);
    const [rpcUrl, noteTransportUrl] = calls.createClient[0];
    expect(rpcUrl).toBe("https://rpc.mainnet.miden.io");
    expect(noteTransportUrl).toBe("https://transport.mainnet.miden.io");
    expect(calls.remoteProver).toEqual(["https://tx-prover.mainnet.miden.io"]);
  });

  it("resolves the mainnet shorthand for each service, ignoring case and surrounding spaces", async () => {
    const calls = captureFactory();

    await MidenClient.create({
      rpcUrl: " Mainnet ",
      noteTransportUrl: "MAINNET",
      proverUrl: "mainnet",
    });

    const [rpcUrl, noteTransportUrl] = calls.createClient[0];
    expect(rpcUrl).toBe("https://rpc.mainnet.miden.io");
    expect(noteTransportUrl).toBe("https://transport.mainnet.miden.io");
    expect(calls.remoteProver).toEqual(["https://tx-prover.mainnet.miden.io"]);
  });

  it("lets createMainnet options override its defaults", async () => {
    const calls = captureFactory();

    await MidenClient.createMainnet({
      proverUrl: "local",
      noteTransportUrl: "https://transport.example",
    });

    const [rpcUrl, noteTransportUrl] = calls.createClient[0];
    expect(rpcUrl).toBe("https://rpc.mainnet.miden.io");
    expect(noteTransportUrl).toBe("https://transport.example");
    expect(calls.remoteProver).toEqual([]);
    expect(calls.localProver).toBe(1);
  });
});
