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

import { MidenClient, MockWasmWebClient, WasmWebClient } from "../index.js";
import {
  createMockWasmWebClient,
  createWasmWebClient,
} from "../node/client-factory.js";
import { validateStoreBackend } from "../utils.js";

let storeCounter = 0;
// Each client claims its store until it terminates, so every test opens its own.
const nextStore = () => `store-backend-test-store-${storeCounter++}`;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("validateStoreBackend", () => {
  it.each([undefined, "indexeddb", "sqlite"])("accepts %s", (value) => {
    expect(() => validateStoreBackend(value)).not.toThrow();
  });

  it.each([
    ["an unknown name", "leveldb"],
    ["a different case", "SQLite"],
    ["the empty string", ""],
    ["null", null],
    ["a number", 1],
    ["an object", {}],
  ])("rejects %s", (_label, value) => {
    expect(() => validateStoreBackend(value)).toThrow(TypeError);
    expect(() => validateStoreBackend(value)).toThrow(/storeBackend/);
  });
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

/** A `Worker` stand-in that records how many were constructed. */
function stubWorker() {
  const constructed = [];
  vi.stubGlobal(
    "Worker",
    class {
      constructor(...args) {
        constructed.push(args);
      }
      addEventListener() {}
      postMessage() {}
      terminate() {}
    }
  );
  return constructed;
}

/** `WasmWebClient.createClient` arguments with `storeBackend` last. */
const createClientArgs = (store, useWorker, storeBackend) => [
  "rpc",
  "transport",
  undefined,
  store,
  undefined,
  useWorker,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  false,
  storeBackend,
];

/** `WasmWebClient.createClientWithExternalKeystore` arguments with `storeBackend` last. */
const createWithKeystoreArgs = (store, useWorker, storeBackend) => [
  "rpc",
  "transport",
  undefined,
  store,
  undefined,
  undefined,
  () => {},
  undefined,
  useWorker,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  false,
  storeBackend,
];

describe("WasmWebClient factories pass storeBackend to WASM", () => {
  it("createClient appends it after the retry options", async () => {
    const { calls } = stubWasmClient();
    await WasmWebClient.createClient(
      ...createClientArgs(nextStore(), false, "sqlite")
    );
    const [args] = calls.createClient;
    expect(args).toHaveLength(8);
    expect(args[7]).toBe("sqlite");
  });

  it("createClientWithExternalKeystore appends it after the retry options", async () => {
    const { calls } = stubWasmClient();
    await WasmWebClient.createClientWithExternalKeystore(
      ...createWithKeystoreArgs(nextStore(), false, "sqlite")
    );
    const [args] = calls.createClientWithExternalKeystore;
    expect(args).toHaveLength(11);
    expect(args[10]).toBe("sqlite");
  });

  it("passes undefined when it is omitted, which WASM reads as IndexedDB", async () => {
    const { calls } = stubWasmClient();
    await WasmWebClient.createClient(
      ...createClientArgs(nextStore(), false, undefined)
    );
    await WasmWebClient.createClientWithExternalKeystore(
      ...createWithKeystoreArgs(nextStore(), false, undefined)
    );
    expect(calls.createClient[0][7]).toBeUndefined();
    expect(calls.createClientWithExternalKeystore[0][10]).toBeUndefined();
  });

  it("rejects an unknown value before touching WASM or a worker", async () => {
    const { spy } = stubWasmClient();
    const workers = stubWorker();
    await expect(
      WasmWebClient.createClient(
        ...createClientArgs(nextStore(), true, "leveldb")
      )
    ).rejects.toThrow(/storeBackend/);
    await expect(
      WasmWebClient.createClientWithExternalKeystore(
        ...createWithKeystoreArgs(nextStore(), true, "leveldb")
      )
    ).rejects.toThrow(TypeError);
    expect(spy).not.toHaveBeenCalled();
    expect(workers).toHaveLength(0);
  });
});

describe("the SQLite store turns the worker shim off", () => {
  it("spawns no worker for sqlite, even when useWorker is true", async () => {
    stubWasmClient();
    const workers = stubWorker();
    const client = await WasmWebClient.createClient(
      ...createClientArgs(nextStore(), true, "sqlite")
    );
    expect(workers).toHaveLength(0);
    expect(client.useWorker).toBe(false);
  });

  it("spawns no worker for sqlite with an external keystore", async () => {
    stubWasmClient();
    const workers = stubWorker();
    const client = await WasmWebClient.createClientWithExternalKeystore(
      ...createWithKeystoreArgs(nextStore(), true, "sqlite")
    );
    expect(workers).toHaveLength(0);
    expect(client.useWorker).toBe(false);
  });

  it.each([undefined, "indexeddb"])(
    "still spawns the worker for storeBackend %s",
    (storeBackend) => {
      const workers = stubWorker();
      const client = new WasmWebClient(
        "rpc",
        "transport",
        undefined,
        nextStore(),
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        storeBackend
      );
      expect(workers).toHaveLength(1);
      expect(client.useWorker).toBe(true);
    }
  );
});

describe("MidenClient.create forwards storeBackend", () => {
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

  it("to createClient as the last argument", async () => {
    const calls = captureFactory();
    await MidenClient.create({ rpcUrl: "testnet", storeBackend: "sqlite" });
    const [args] = calls.createClient;
    expect(args).toHaveLength(13);
    expect(args[12]).toBe("sqlite");
  });

  it("to createClientWithExternalKeystore as the last argument", async () => {
    const calls = captureFactory();
    await MidenClient.create({
      rpcUrl: "testnet",
      keystore: { getKey: () => {}, insertKey: () => {}, sign: () => {} },
      storeBackend: "sqlite",
    });
    const [args] = calls.createClientWithExternalKeystore;
    expect(args).toHaveLength(16);
    expect(args[15]).toBe("sqlite");
  });

  it("as undefined when it is omitted", async () => {
    const calls = captureFactory();
    await MidenClient.create({ rpcUrl: "testnet" });
    expect(calls.createClient[0][12]).toBeUndefined();
  });

  it("rejects an unknown value before creating anything", async () => {
    const calls = captureFactory();
    await expect(
      MidenClient.create({ rpcUrl: "testnet", storeBackend: "leveldb" })
    ).rejects.toThrow(TypeError);
    expect(calls.createClient).toHaveLength(0);
  });
});

describe("the Node.js factory checks storeBackend", () => {
  function rawSdk() {
    const calls = [];
    class WebClient {
      async createClient(...args) {
        calls.push(args);
      }
    }
    return { sdk: { WebClient }, calls };
  }

  /** The Node.js factory's `createClient` arguments with `storeBackend` last. */
  const nodeArgs = (storeBackend) => [
    "rpc",
    null,
    undefined,
    nextStore(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    storeBackend,
  ];

  it.each([undefined, "sqlite"])(
    "builds the native client for storeBackend %s, without passing it on",
    async (storeBackend) => {
      const { sdk, calls } = rawSdk();
      const factory = createWasmWebClient(sdk, { dataDir: "/nonexistent" });
      await factory.createClient(...nodeArgs(storeBackend));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveLength(8);
    }
  );

  it("rejects indexeddb, which the native store cannot be", async () => {
    const { sdk, calls } = rawSdk();
    const factory = createWasmWebClient(sdk, { dataDir: "/nonexistent" });
    await expect(
      factory.createClient(...nodeArgs("indexeddb"))
    ).rejects.toThrow(/indexeddb/);
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown value before building the native client", async () => {
    const { sdk, calls } = rawSdk();
    const factory = createWasmWebClient(sdk, { dataDir: "/nonexistent" });
    await expect(factory.createClient(...nodeArgs("leveldb"))).rejects.toThrow(
      TypeError
    );
    expect(calls).toHaveLength(0);
  });
});

describe("the mock client takes storeBackend too", () => {
  /** A stub wasm-bindgen `WebClient` that records each mock create call. */
  function stubMockWasmClient() {
    const calls = [];
    vi.spyOn(
      MockWasmWebClient.prototype,
      "getWasmWebClient"
    ).mockImplementation(async () => ({
      createMockClient: async (...args) => {
        calls.push(args);
      },
      serializeMockChain: async () => new Uint8Array(),
      serializeMockNoteTransportNode: async () => new Uint8Array(),
    }));
    return calls;
  }

  it("passes it to WASM after the store name, without a worker for sqlite", async () => {
    const calls = stubMockWasmClient();
    const workers = stubWorker();
    const store = nextStore();
    const client = await MockWasmWebClient.createClient(
      undefined,
      undefined,
      undefined,
      undefined,
      store,
      "sqlite"
    );
    expect(calls).toEqual([[null, null, null, store, "sqlite"]]);
    expect(workers).toHaveLength(0);
    expect(client.useWorker).toBe(false);
  });

  it("rejects an unknown value before touching WASM", async () => {
    const calls = stubMockWasmClient();
    await expect(
      MockWasmWebClient.createClient(
        undefined,
        undefined,
        undefined,
        undefined,
        nextStore(),
        "leveldb"
      )
    ).rejects.toThrow(/storeBackend/);
    expect(calls).toHaveLength(0);
  });

  describe("through MidenClient.createMock", () => {
    let saved;

    beforeEach(() => {
      saved = [MidenClient._MockWasmWebClient, MidenClient._getWasmOrThrow];
    });

    afterEach(() => {
      [MidenClient._MockWasmWebClient, MidenClient._getWasmOrThrow] = saved;
    });

    function captureMockFactory() {
      const calls = [];
      MidenClient._MockWasmWebClient = {
        createClient: async (...args) => {
          calls.push(args);
          return {};
        },
      };
      MidenClient._getWasmOrThrow = async () => ({});
      return calls;
    }

    it("forwards it as the last argument", async () => {
      const calls = captureMockFactory();
      await MidenClient.createMock({ storeName: "s", storeBackend: "sqlite" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveLength(6);
      expect(calls[0][4]).toBe("s");
      expect(calls[0][5]).toBe("sqlite");
    });

    it("rejects an unknown value before creating anything", async () => {
      const calls = captureMockFactory();
      await expect(
        MidenClient.createMock({ storeBackend: "leveldb" })
      ).rejects.toThrow(TypeError);
      expect(calls).toHaveLength(0);
    });
  });

  describe("on Node.js", () => {
    function rawSdk() {
      const calls = [];
      class WebClient {
        async createMockClient(...args) {
          calls.push(args);
        }
      }
      return { sdk: { WebClient }, calls };
    }

    it.each([undefined, "sqlite"])(
      "builds the native mock client for storeBackend %s",
      async (storeBackend) => {
        const { sdk, calls } = rawSdk();
        const factory = createMockWasmWebClient(sdk);
        await factory.createClient(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          storeBackend
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]).toHaveLength(5);
      }
    );

    it("rejects indexeddb, which the native store cannot be", async () => {
      const { sdk, calls } = rawSdk();
      const factory = createMockWasmWebClient(sdk);
      await expect(
        factory.createClient(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "indexeddb"
        )
      ).rejects.toThrow(/indexeddb/);
      expect(calls).toHaveLength(0);
    });
  });
});
