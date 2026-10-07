import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `index.js` re-exports the wasm-bindgen surface from `../Cargo.toml`, which
// the node test environment cannot load, and reaches the wasm module through
// `../wasm.js`. Both are stubbed; the stand-in module's `WebClient` counts the
// clients built, so a test can tell that a terminated wrapper builds none.
const fakeWasm = vi.hoisted(() => {
  class WebClient {
    static constructed = 0;
    constructor() {
      WebClient.constructed += 1;
      this.free = vi.fn();
      this.createMockClient = vi.fn(async () => {});
    }
  }
  return {
    WebClient,
    TransactionResult: { deserialize: () => ({ id: () => "tx-id" }) },
  };
});
vi.mock("../../Cargo.toml", () => ({}));
vi.mock("../wasm.js", () => ({ default: async () => fakeWasm }));

import { MidenClient } from "../client.js";
import {
  WasmWebClient,
  MockWasmWebClient,
  __createClientProxyForTest as createClientProxy,
} from "../index.js";

// `MidenClient` is constructible without a real WASM module as long as the test
// supplies the two things its constructor takes: the proxied inner client and a
// `getWasm` thunk. The resource classes it builds are covered separately under
// `__tests__/resources/`; what is exercised here is the client's own surface.

const makeWasm = () => ({
  AccountId: {
    fromHex: vi.fn((hex) => ({ kind: "fromHex", hex, toString: () => hex })),
    fromBech32: vi.fn((b32) => ({
      kind: "fromBech32",
      bech32: b32,
      toString: () => b32,
    })),
  },
});

const makeClient = (innerOverrides = {}) => {
  const wasm = makeWasm();
  const inner = {
    feeAwareTransactionRequestBuilder: vi
      .fn()
      .mockResolvedValue({ kind: "builder" }),
    storeIdentifier: vi.fn().mockResolvedValue("store"),
    ...innerOverrides,
  };
  const client = new MidenClient(inner, async () => wasm, null);
  return { client, inner, wasm };
};

describe("MidenClient.feeAwareTransactionRequestBuilder", () => {
  let client;
  let inner;
  let wasm;

  beforeEach(() => {
    ({ client, inner, wasm } = makeClient());
  });

  it("returns the builder the inner client produced", async () => {
    await expect(
      client.feeAwareTransactionRequestBuilder("0xabc")
    ).resolves.toEqual({ kind: "builder" });
  });

  // Every documented call form goes through `resolveAccountRef`. Without it the
  // hex/bech32/Account forms reach the WASM boundary unparsed, which is what the
  // README, the narrative docs and the CHANGELOG all show a consumer passing.
  it("parses a hex string into an AccountId", async () => {
    await client.feeAwareTransactionRequestBuilder("0xabc");
    expect(wasm.AccountId.fromHex).toHaveBeenCalledWith("0xabc");
    expect(inner.feeAwareTransactionRequestBuilder).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "fromHex", hex: "0xabc" }),
      undefined,
      undefined,
      undefined
    );
  });

  it("parses a bech32 string into an AccountId", async () => {
    await client.feeAwareTransactionRequestBuilder("mtst1qabc");
    expect(wasm.AccountId.fromBech32).toHaveBeenCalledWith("mtst1qabc");
    expect(inner.feeAwareTransactionRequestBuilder).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "fromBech32", bech32: "mtst1qabc" }),
      undefined,
      undefined,
      undefined
    );
  });

  it("resolves an Account through its id()", async () => {
    const id = { toString: () => "0xfromAccount" };
    const account = { id: vi.fn(() => id) };
    await client.feeAwareTransactionRequestBuilder(account);
    expect(account.id).toHaveBeenCalled();
    expect(inner.feeAwareTransactionRequestBuilder).toHaveBeenCalledWith(
      id,
      undefined,
      undefined,
      undefined
    );
  });

  it("passes an AccountId through untouched", async () => {
    const accountId = { toString: () => "0xalready" };
    await client.feeAwareTransactionRequestBuilder(accountId);
    expect(wasm.AccountId.fromHex).not.toHaveBeenCalled();
    expect(inner.feeAwareTransactionRequestBuilder).toHaveBeenCalledWith(
      accountId,
      undefined,
      undefined,
      undefined
    );
  });

  it("rejects a nullish account rather than passing null into WASM", async () => {
    await expect(
      client.feeAwareTransactionRequestBuilder(undefined)
    ).rejects.toThrow(/cannot be null or undefined/i);
    expect(inner.feeAwareTransactionRequestBuilder).not.toHaveBeenCalled();
  });

  // Every multisig override is off unless asked for: the cases above pin the
  // `undefined`s that mean "SDK default", these pin that each option reaches the
  // WASM boundary unchanged, in its own positional slot.
  it("forwards an approval expiration delta", async () => {
    const accountId = { kind: "accountId" };
    await client.feeAwareTransactionRequestBuilder(accountId, {
      approvalExpirationDelta: 100,
    });
    expect(inner.feeAwareTransactionRequestBuilder).toHaveBeenCalledWith(
      accountId,
      100,
      undefined,
      undefined
    );
  });

  // The two a co-signer needs to reproduce a proposal rather than receive it.
  it("forwards the salt and bound block a co-signer must agree on", async () => {
    const accountId = { kind: "accountId" };
    const salt = { kind: "word" };
    await client.feeAwareTransactionRequestBuilder(accountId, {
      feeConversionSalt: salt,
      boundBlockNum: 42,
    });
    expect(inner.feeAwareTransactionRequestBuilder).toHaveBeenCalledWith(
      accountId,
      undefined,
      salt,
      42
    );
  });

  it("throws once terminated", async () => {
    client.terminate();
    await expect(
      client.feeAwareTransactionRequestBuilder("0xabc")
    ).rejects.toThrow("Client terminated");
    expect(inner.feeAwareTransactionRequestBuilder).not.toHaveBeenCalled();
  });
});

describe("WasmWebClient.terminate", () => {
  const wasmSymbol = Symbol("wasm method");

  // Stands in for the wasm-bindgen client: its methods live on the prototype,
  // as wasm-bindgen's do, and refuse to run once it has been freed.
  class FakeWasmClient {
    constructor() {
      this.freed = false;
      this.calls = 0;
      this.free = vi.fn(() => {
        this.freed = true;
      });
    }
    async getAccounts() {
      this.calls += 1;
      if (this.freed) throw new Error("used after free");
      return ["account"];
    }
    async newWallet() {
      if (this.freed) throw new Error("used after free");
      return "wallet";
    }
    async submitNewTransaction() {
      throw new Error("ran in-realm");
    }
    serializeMockChain() {
      return new Uint8Array([1]);
    }
    serializeMockNoteTransportNode() {
      return new Uint8Array([2]);
    }
    [wasmSymbol]() {}
  }

  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  // Node has no Worker, so the wrapper is built in-realm; a test that needs a
  // worker attaches a stand-in for one.
  const makeWebClient = (wasmClient = new FakeWasmClient()) => {
    const client = new WasmWebClient(
      undefined,
      undefined,
      undefined,
      "store",
      undefined,
      undefined,
      undefined,
      undefined,
      false
    );
    client.wasmWebClient = wasmClient;
    client.wasmWebClientPromise = Promise.resolve(wasmClient);
    return { client, wasmClient };
  };

  const attachWorker = (client) => {
    const worker = { postMessage: vi.fn(), terminate: vi.fn() };
    client.worker = worker;
    client.pendingRequests = new Map();
    return worker;
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("frees the wasm client only after the serialized call already running settles", async () => {
    const { client, wasmClient } = makeWebClient();
    const inFlight = deferred();
    const running = client._serializeWasmCall(() => inFlight.promise);

    client.terminate();
    await Promise.resolve();
    expect(wasmClient.free).not.toHaveBeenCalled();
    expect(client.wasmWebClient).toBe(wasmClient);

    inFlight.resolve("done");
    await expect(running).resolves.toBe("done");
    await client.waitForIdle();
    expect(wasmClient.free).toHaveBeenCalledTimes(1);
    expect(client.wasmWebClient).toBeNull();
    expect(client.wasmWebClientPromise).toBeNull();
  });

  it("runs a wrapped call queued before terminate against the attached client", async () => {
    const { client, wasmClient } = makeWebClient();
    const inFlight = deferred();
    client._serializeWasmCall(() => inFlight.promise);
    const queued = client.newWallet("private", "auth");

    client.terminate();
    inFlight.resolve();
    await expect(queued).resolves.toBe("wallet");
    await client.waitForIdle();
    expect(wasmClient.free).toHaveBeenCalledTimes(1);
  });

  it("rejects later calls instead of building a fresh wasm client", async () => {
    const { client } = makeWebClient();
    client.terminate();
    await client.waitForIdle();
    const constructed = fakeWasm.WebClient.constructed;

    await expect(client.getWasmWebClient()).rejects.toThrow(/terminated/);
    await expect(client.callMethodWithWorker("syncState")).rejects.toThrow(
      /terminated/
    );
    await expect(client.newWallet("private", "auth")).rejects.toThrow(
      /terminated/
    );
    expect(fakeWasm.WebClient.constructed).toBe(constructed);
  });

  it("rejects a worker call queued before terminate instead of running it in-realm", async () => {
    const { client } = makeWebClient();
    const worker = attachWorker(client);
    const inFlight = deferred();
    client._serializeWasmCall(() => inFlight.promise);
    const queued = client.submitNewTransaction(
      { toString: () => "0xacc" },
      { serialize: () => new Uint8Array() }
    );

    client.terminate();
    expect(worker.terminate).toHaveBeenCalled();
    inFlight.resolve();
    await expect(queued).rejects.toThrow(/terminated/);
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it("still runs a call nested in an in-flight _withInnerWebClient inline", async () => {
    const { client } = makeWebClient();
    client._withInnerLockDepth = 1;
    client.terminate();
    await expect(client._serializeWasmCall(async () => "inline")).resolves.toBe(
      "inline"
    );
  });

  it("keeps the call chain usable when freeing the wasm client throws", async () => {
    const { client, wasmClient } = makeWebClient();
    wasmClient.free = vi.fn(() => {
      throw new Error("still borrowed");
    });

    client.terminate();
    // Nothing awaits the chain here, so a rejection left on it would surface
    // as an unhandled rejection and fail the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wasmClient.free).toHaveBeenCalledTimes(1);
    expect(client.wasmWebClient).toBeNull();
  });

  it("can be called twice", async () => {
    const { client, wasmClient } = makeWebClient();
    const worker = attachWorker(client);
    client.terminate();
    expect(() => client.terminate()).not.toThrow();
    await client.waitForIdle();
    expect(worker.terminate).toHaveBeenCalled();
    expect(wasmClient.free).toHaveBeenCalledTimes(1);
  });

  it("lets a proxied call queued before terminate finish before the free", async () => {
    const { client, wasmClient } = makeWebClient();
    const proxy = createClientProxy(client);
    const inFlight = deferred();
    client._serializeWasmCall(() => inFlight.promise);
    const queued = proxy.getAccounts();

    client.terminate();
    inFlight.resolve();
    await expect(queued).resolves.toEqual(["account"]);
    await client.waitForIdle();
    expect(wasmClient.free).toHaveBeenCalledTimes(1);
  });

  it("rejects a proxied call made after terminate, before and after the free", async () => {
    const { client, wasmClient } = makeWebClient();
    const proxy = createClientProxy(client);

    client.terminate();
    await expect(proxy.getAccounts()).rejects.toThrow(/terminated/);
    await client.waitForIdle();
    await expect(proxy.getAccounts()).rejects.toThrow(/terminated/);
    expect(wasmClient.calls).toBe(0);
  });

  it("never answers then, a symbol or an unknown name after the free", async () => {
    class ThenableWasmClient extends FakeWasmClient {
      then() {}
    }
    const client = makeWebClient().client;
    client.wasmWebClient = new ThenableWasmClient();
    client.wasmWebClientPromise = null;
    const proxy = createClientProxy(client);

    client.terminate();
    await client.waitForIdle();
    expect(proxy.then).toBeUndefined();
    expect(proxy[wasmSymbol]).toBeUndefined();
    expect(proxy.notAWasmMethod).toBeUndefined();
  });

  it.each([
    ["submitNewTransaction", []],
    ["submitNewTransactionWithProver", [{ serialize: () => "local" }]],
  ])(
    "frees the wasm client a mock %s replaces once the queued calls settle",
    async (method, extraArgs) => {
      const client = new MockWasmWebClient();
      const replaced = new FakeWasmClient();
      client.wasmWebClient = replaced;
      attachWorker(client);
      client.callMethodWithWorker = vi.fn().mockResolvedValue({
        serializedMockChain: [1],
        serializedTransactionResult: [2],
      });
      const inFlight = deferred();
      client._serializeWasmCall(() => inFlight.promise);

      await expect(
        client[method](
          { toString: () => "0xacc" },
          { serialize: () => new Uint8Array() },
          ...extraArgs
        )
      ).resolves.toBe("tx-id");
      expect(client.wasmWebClient).not.toBe(replaced);
      expect(replaced.free).not.toHaveBeenCalled();

      inFlight.resolve();
      await client.waitForIdle();
      expect(replaced.free).toHaveBeenCalledTimes(1);
      expect(client.wasmWebClient.free).not.toHaveBeenCalled();
    }
  );
});
