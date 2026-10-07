import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// `js/index.js` re-exports the wasm-bindgen surface from "../Cargo.toml",
// which the node test environment cannot parse. Nothing below touches WASM.
vi.mock("../../Cargo.toml", () => ({}));

import { MidenClient, WasmWebClient } from "../index.js";
import { WorkerAction } from "../constants.js";
import { validateNoteTransportRetryOptions } from "../utils.js";
import { createWasmWebClient } from "../node/client-factory.js";

const STORE = "retry-options-test-store";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("validateNoteTransportRetryOptions", () => {
  it.each([0, 3, 10])("accepts noteTransportMaxRetries %s", (value) => {
    expect(() =>
      validateNoteTransportRetryOptions(value, undefined)
    ).not.toThrow();
  });

  it.each([0, 250, 60_000])(
    "accepts noteTransportRetryIntervalMs %s",
    (value) => {
      expect(() =>
        validateNoteTransportRetryOptions(undefined, value)
      ).not.toThrow();
    }
  );

  it("accepts both omitted", () => {
    expect(() =>
      validateNoteTransportRetryOptions(undefined, undefined)
    ).not.toThrow();
  });

  const bad = [
    ["-1", -1],
    ["1.5", 1.5],
    ['"3"', "3"],
    ["{}", {}],
    ["null", null],
    ["NaN", NaN],
    ["2**32", 2 ** 32],
  ];

  it.each([...bad, ["11", 11]])(
    "rejects noteTransportMaxRetries %s",
    (_label, value) => {
      expect(() => validateNoteTransportRetryOptions(value, undefined)).toThrow(
        TypeError
      );
      expect(() => validateNoteTransportRetryOptions(value, undefined)).toThrow(
        /noteTransportMaxRetries/
      );
    }
  );

  it.each([...bad, ["60001", 60_001]])(
    "rejects noteTransportRetryIntervalMs %s",
    (_label, value) => {
      expect(() => validateNoteTransportRetryOptions(undefined, value)).toThrow(
        TypeError
      );
      expect(() => validateNoteTransportRetryOptions(undefined, value)).toThrow(
        /noteTransportRetryIntervalMs/
      );
    }
  );
});

/** A stub wasm-bindgen `WebClient` that records each create call. */
function stubWasmClient() {
  const calls = { createClient: [], createClientWithExternalKeystore: [] };
  const spy = vi
    .spyOn(WasmWebClient.prototype, "getWasmWebClient")
    .mockImplementation(async () => ({
      createClient: async (...args) => {
        calls.createClient.push(args);
      },
      createClientWithExternalKeystore: async (...args) => {
        calls.createClientWithExternalKeystore.push(args);
      },
    }));
  return { calls, spy };
}

describe("WasmWebClient factories pass the retry options to WASM", () => {
  it("createClient appends them after feeFaucetId", async () => {
    const { calls } = stubWasmClient();
    await WasmWebClient.createClient(
      "rpc",
      "transport",
      undefined,
      STORE,
      undefined,
      false,
      undefined,
      "0xfee",
      5,
      1_000
    );
    const [args] = calls.createClient;
    expect(args).toHaveLength(7);
    expect(args[4]).toBe("0xfee");
    expect(args[5]).toBe(5);
    expect(args[6]).toBe(1_000);
  });

  it("createClientWithExternalKeystore appends them after the callbacks", async () => {
    const { calls } = stubWasmClient();
    const sign = () => {};
    await WasmWebClient.createClientWithExternalKeystore(
      "rpc",
      "transport",
      undefined,
      STORE,
      undefined,
      undefined,
      sign,
      undefined,
      false,
      undefined,
      "0xfee",
      0,
      60_000
    );
    const [args] = calls.createClientWithExternalKeystore;
    expect(args).toHaveLength(10);
    expect(args[4]).toBe("0xfee");
    expect(args[7]).toBe(sign);
    expect(args[8]).toBe(0);
    expect(args[9]).toBe(60_000);
  });

  it("rejects an out-of-range value before touching WASM", async () => {
    const { spy } = stubWasmClient();
    await expect(
      WasmWebClient.createClient(
        "rpc",
        "transport",
        undefined,
        STORE,
        undefined,
        false,
        undefined,
        undefined,
        -1
      )
    ).rejects.toThrow(/noteTransportMaxRetries/);
    await expect(
      WasmWebClient.createClientWithExternalKeystore(
        "rpc",
        "transport",
        undefined,
        STORE,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        2 ** 32
      )
    ).rejects.toThrow(/noteTransportRetryIntervalMs/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the worker receives the retry options", () => {
  it("puts them at INIT args 10 and 11", async () => {
    const posted = [];
    let onMessage;
    vi.stubGlobal(
      "Worker",
      class {
        addEventListener(type, listener) {
          if (type === "message") onMessage = listener;
        }
        postMessage(message) {
          posted.push(message);
        }
        terminate() {}
      }
    );

    new WasmWebClient(
      "rpc",
      "transport",
      undefined,
      STORE,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      "0xfee",
      7,
      500
    );
    await onMessage({ data: { loaded: true } });
    await Promise.resolve();

    const init = posted.find((m) => m.action === WorkerAction.INIT);
    expect(init.args).toHaveLength(12);
    expect(init.args[9]).toBe("0xfee");
    expect(init.args[10]).toBe(7);
    expect(init.args[11]).toBe(500);
  });
});

describe("MidenClient.create forwards the retry options", () => {
  let saved;

  beforeEach(() => {
    saved = [MidenClient._WasmWebClient, MidenClient._getWasmOrThrow];
  });

  afterEach(() => {
    [MidenClient._WasmWebClient, MidenClient._getWasmOrThrow] = saved;
  });

  function captureFactory() {
    const calls = { createClient: [], createClientWithExternalKeystore: [] };
    MidenClient._WasmWebClient = {
      createClient: async (...args) => {
        calls.createClient.push(args);
        return {};
      },
      createClientWithExternalKeystore: async (...args) => {
        calls.createClientWithExternalKeystore.push(args);
        return {};
      },
    };
    MidenClient._getWasmOrThrow = async () => ({});
    return calls;
  }

  it("to createClient after feeFaucetId", async () => {
    const calls = captureFactory();
    await MidenClient.create({
      rpcUrl: "testnet",
      feeFaucetId: "0xfee",
      noteTransportMaxRetries: 2,
      noteTransportRetryIntervalMs: 100,
    });
    const [args] = calls.createClient;
    expect(args).toHaveLength(10);
    expect(args[7]).toBe("0xfee");
    expect(args[8]).toBe(2);
    expect(args[9]).toBe(100);
  });

  it("to createClientWithExternalKeystore after feeFaucetId", async () => {
    const calls = captureFactory();
    await MidenClient.create({
      rpcUrl: "testnet",
      keystore: { getKey: () => {}, insertKey: () => {}, sign: () => {} },
      feeFaucetId: "0xfee",
      noteTransportMaxRetries: 0,
      noteTransportRetryIntervalMs: 60_000,
    });
    const [args] = calls.createClientWithExternalKeystore;
    expect(args).toHaveLength(13);
    expect(args[10]).toBe("0xfee");
    expect(args[11]).toBe(0);
    expect(args[12]).toBe(60_000);
  });

  it("rejects an out-of-range value before creating anything", async () => {
    const calls = captureFactory();
    await expect(
      MidenClient.create({ rpcUrl: "testnet", noteTransportMaxRetries: 11 })
    ).rejects.toThrow(TypeError);
    expect(calls.createClient).toHaveLength(0);
  });
});

describe("the Node.js factory forwards the retry options", () => {
  function rawSdk() {
    const calls = [];
    class WebClient {
      async createClient(...args) {
        calls.push(args);
      }
    }
    return { sdk: { WebClient }, calls };
  }

  it("as the last two napi createClient arguments", async () => {
    const { sdk, calls } = rawSdk();
    const factory = createWasmWebClient(sdk, { dataDir: "/nonexistent" });
    await factory.createClient(
      "rpc",
      "transport",
      undefined,
      STORE,
      undefined,
      undefined,
      undefined,
      "0xfee",
      4,
      750
    );
    const [args] = calls;
    expect(args).toHaveLength(8);
    expect(args[5]).toBe("0xfee");
    expect(args[6]).toBe(4);
    expect(args[7]).toBe(750);
  });

  it("as null when omitted", async () => {
    const { sdk, calls } = rawSdk();
    const factory = createWasmWebClient(sdk, { dataDir: "/nonexistent" });
    await factory.createClient("rpc", null, undefined, STORE);
    expect(calls[0].slice(6)).toEqual([null, null]);
  });

  it("rejects an out-of-range value before building the native client", async () => {
    const { sdk, calls } = rawSdk();
    const factory = createWasmWebClient(sdk, { dataDir: "/nonexistent" });
    await expect(
      factory.createClient(
        "rpc",
        null,
        undefined,
        STORE,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        1.5
      )
    ).rejects.toThrow(/noteTransportRetryIntervalMs/);
    expect(calls).toHaveLength(0);
  });
});
