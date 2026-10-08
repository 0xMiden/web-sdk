import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `index.js` re-exports the wasm-bindgen surface from `../Cargo.toml`, which
// the node test environment cannot load, and reaches the wasm module through
// `../wasm.js`. Both are stubbed; the stand-in module's `WebClient` counts the
// clients built, so a test can tell that a terminated wrapper builds none, keeps
// the last one built, and lets a test hold `createMockClient` open.
const fakeWasm = vi.hoisted(() => {
  class WebClient {
    static constructed = 0;
    static latest = null;
    static pendingCreateMockClient = null;
    constructor() {
      WebClient.constructed += 1;
      WebClient.latest = this;
      this.free = vi.fn();
      this.createMockClient = vi.fn(
        async () => WebClient.pendingCreateMockClient
      );
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
    lastAuthError() {
      return null;
    }
    buildSwapTag() {
      return "tag";
    }
    async proveBlock() {}
    get keystore() {
      return "keystore";
    }
    serializeMockChain() {
      if (this.freed) throw new Error("used after free");
      return new Uint8Array([1]);
    }
    serializeMockNoteTransportNode() {
      return new Uint8Array([2]);
    }
    [wasmSymbol]() {}
  }

  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  // What a promise has come to once the microtask queue drains: "resolved",
  // its rejection message, or "pending".
  const outcomeAfterFlush = (promise) =>
    Promise.race([
      promise.then(
        () => "resolved",
        (error) => error.message
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);

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

  const attachWorker = (client, { ready = true } = {}) => {
    const worker = { postMessage: vi.fn(), terminate: vi.fn() };
    client.worker = worker;
    client.pendingRequests = new Map();
    client.ready = new Promise((resolve, reject) => {
      client.readyRejecter = reject;
      if (ready) resolve();
    });
    client.ready.catch(() => {});
    return worker;
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fakeWasm.WebClient.pendingCreateMockClient = null;
    fakeWasm.WebClient.latest = null;
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

  it("settles a worker call in flight at terminate and still frees the client", async () => {
    const { client, wasmClient } = makeWebClient();
    const worker = attachWorker(client);
    const inFlight = client.submitNewTransaction(
      { toString: () => "0xacc" },
      { serialize: () => new Uint8Array() }
    );
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());

    client.terminate();
    const call = outcomeAfterFlush(inFlight);
    expect(await outcomeAfterFlush(client.waitForIdle())).toBe("resolved");
    expect(wasmClient.free).toHaveBeenCalledTimes(1);
    expect(await call).toBe("WebClient terminated");
    expect(client.pendingRequests.size).toBe(0);
  });

  it("settles a worker call still waiting for the worker to be ready", async () => {
    const { client, wasmClient } = makeWebClient();
    const worker = attachWorker(client, { ready: false });
    const waiting = client.submitNewTransaction(
      { toString: () => "0xacc" },
      { serialize: () => new Uint8Array() }
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    client.terminate();
    const call = outcomeAfterFlush(waiting);
    expect(await outcomeAfterFlush(client.waitForIdle())).toBe("resolved");
    expect(wasmClient.free).toHaveBeenCalledTimes(1);
    expect(await call).toBe("WebClient terminated");
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it("never posts a worker call that terminate overtakes", async () => {
    const { client } = makeWebClient();
    const worker = attachWorker(client);
    const call = client.callMethodWithWorker("syncChain");

    client.terminate();
    expect(await outcomeAfterFlush(call)).toBe("WebClient terminated");
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(client.pendingRequests.size).toBe(0);
  });

  it("still runs a call nested in an in-flight _withInnerWebClient inline", async () => {
    const { client } = makeWebClient();
    client._withInnerLockDepth = 1;
    client.terminate();
    await expect(client._serializeWasmCall(async () => "inline")).resolves.toBe(
      "inline"
    );
  });

  it("keeps the call chain usable and reports it when freeing the wasm client throws", async () => {
    const { client, wasmClient } = makeWebClient();
    const borrowed = new Error("still borrowed");
    wasmClient.free = vi.fn(() => {
      throw borrowed;
    });

    client.terminate();
    // Nothing awaits the chain here, so a rejection left on it would surface
    // as an unhandled rejection and fail the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wasmClient.free).toHaveBeenCalledTimes(1);
    expect(client.wasmWebClient).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "WebClient: failed to free the wasm client on terminate:",
      borrowed
    );
  });

  it("fails each member in its live call shape as soon as terminate returns", async () => {
    const { client, wasmClient } = makeWebClient();
    const proxy = createClientProxy(client);

    client.terminate();
    expect(() => proxy.buildSwapTag()).toThrow("WebClient terminated");
    expect(() => proxy.lastAuthError()).toThrow("WebClient terminated");
    expect(() => proxy.keystore).toThrow("WebClient terminated");
    expect(proxy.then).toBeUndefined();
    expect(proxy[wasmSymbol]).toBeUndefined();
    const proving = proxy.proveBlock();
    expect(wasmClient.free).not.toHaveBeenCalled();
    expect(proving).toBeInstanceOf(Promise);
    await expect(proving).rejects.toThrow("WebClient terminated");
  });

  it("keeps the live route for a member read inside an in-flight _withInnerWebClient", () => {
    const { client } = makeWebClient();
    const proxy = createClientProxy(client);
    client._withInnerLockDepth = 1;

    client.terminate();
    expect(proxy.buildSwapTag()).toBe("tag");
    expect(proxy.keystore).toBe("keystore");
  });

  it("frees the wasm client only once a raw-bound call started before terminate settles", async () => {
    const { client, wasmClient } = makeWebClient();
    const proxy = createClientProxy(client);
    const proving = deferred();
    wasmClient.proveBlock = vi.fn(() => proving.promise);
    const running = proxy.proveBlock();

    client.terminate();
    expect(await outcomeAfterFlush(client.waitForIdle())).toBe("pending");
    expect(wasmClient.free).not.toHaveBeenCalled();

    proving.resolve("proved");
    await expect(running).resolves.toBe("proved");
    expect(await outcomeAfterFlush(client.waitForIdle())).toBe("resolved");
    expect(wasmClient.free).toHaveBeenCalledTimes(1);
    expect(client._rawWasmCalls.size).toBe(0);
  });

  it("frees the wasm client once a raw-bound call started before terminate rejects", async () => {
    const { client, wasmClient } = makeWebClient();
    const proxy = createClientProxy(client);
    const proving = deferred();
    wasmClient.proveBlock = vi.fn(() => proving.promise);
    const running = outcomeAfterFlush(proxy.proveBlock());

    client.terminate();
    proving.reject(new Error("prove failed"));
    expect(await running).toBe("prove failed");
    expect(await outcomeAfterFlush(client.waitForIdle())).toBe("resolved");
    expect(wasmClient.free).toHaveBeenCalledTimes(1);
    expect(client._rawWasmCalls.size).toBe(0);
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

  it("keeps each freed member's call shape", async () => {
    const { client } = makeWebClient();
    const proxy = createClientProxy(client);
    client.terminate();
    await client.waitForIdle();

    expect(() => proxy.lastAuthError()).toThrow(/terminated/);
    expect(() => proxy.buildSwapTag()).toThrow(/terminated/);
    expect(() => proxy.keystore).toThrow(/terminated/);
    const proving = proxy.proveBlock();
    expect(proving).toBeInstanceOf(Promise);
    await expect(proving).rejects.toThrow(/terminated/);
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

  const mockSubmits = [
    ["submitNewTransaction", []],
    ["submitNewTransactionWithProver", [{ serialize: () => "local" }]],
  ];

  const makeMockClient = () => {
    const client = new MockWasmWebClient();
    const replaced = new FakeWasmClient();
    client.wasmWebClient = replaced;
    attachWorker(client);
    return { client, replaced };
  };

  const workerResult = () =>
    vi.fn().mockResolvedValue({
      serializedMockChain: [1],
      serializedTransactionResult: [2],
    });

  const submit = (client, method, extraArgs) =>
    client[method](
      { toString: () => "0xacc" },
      { serialize: () => new Uint8Array() },
      ...extraArgs
    );

  it.each(mockSubmits)(
    "frees the wasm client a mock %s replaces once the queued calls settle",
    async (method, extraArgs) => {
      const { client, replaced } = makeMockClient();
      client.callMethodWithWorker = workerResult();
      const inFlight = deferred();
      client._serializeWasmCall(() => inFlight.promise);

      const submitted = submit(client, method, extraArgs);
      await Promise.resolve();
      expect(replaced.free).not.toHaveBeenCalled();

      inFlight.resolve();
      await expect(submitted).resolves.toBe("tx-id");
      await client.waitForIdle();
      const created = fakeWasm.WebClient.latest;
      expect(client.wasmWebClient).toBe(created);
      await expect(client.wasmWebClientPromise).resolves.toBe(created);
      expect(replaced.free).toHaveBeenCalledTimes(1);
      expect(created.free).not.toHaveBeenCalled();
    }
  );

  it.each(mockSubmits)(
    "does not free the client a mock %s is still creating",
    async (method, extraArgs) => {
      const { client, replaced } = makeMockClient();
      client.callMethodWithWorker = workerResult();
      const creating = deferred();
      fakeWasm.WebClient.pendingCreateMockClient = creating.promise;

      const submitted = submit(client, method, extraArgs);
      await vi.waitFor(() =>
        expect(fakeWasm.WebClient.latest?.createMockClient).toHaveBeenCalled()
      );
      const created = fakeWasm.WebClient.latest;
      expect(client.wasmWebClient).toBe(replaced);
      client.terminate();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(client.wasmWebClient).toBe(replaced);
      expect(created.free).not.toHaveBeenCalled();
      expect(replaced.free).not.toHaveBeenCalled();

      creating.resolve();
      await expect(submitted).resolves.toBe("tx-id");
      expect(replaced.free).toHaveBeenCalledTimes(1);
      await client.waitForIdle();
      expect(created.free).toHaveBeenCalledTimes(1);
      expect(replaced.free).toHaveBeenCalledTimes(1);
    }
  );

  it.each(mockSubmits)(
    "keeps the replaced client when a mock %s cannot create its replacement",
    async (method, extraArgs) => {
      const { client, replaced } = makeMockClient();
      client.callMethodWithWorker = workerResult();
      const creating = deferred();
      fakeWasm.WebClient.pendingCreateMockClient = creating.promise;

      const submitted = submit(client, method, extraArgs);
      await vi.waitFor(() =>
        expect(fakeWasm.WebClient.latest?.createMockClient).toHaveBeenCalled()
      );
      const created = fakeWasm.WebClient.latest;
      created.free = vi.fn(() => {
        throw new Error("still borrowed");
      });
      creating.reject(new Error("mock chain rejected"));

      await expect(submitted).rejects.toThrow("mock chain rejected");
      expect(client.wasmWebClient).toBe(replaced);
      expect(client.wasmWebClientPromise).toBeNull();
      expect(created.free).toHaveBeenCalledTimes(1);
      expect(replaced.free).not.toHaveBeenCalled();
    }
  );

  it.each(mockSubmits)(
    "never reads a freed client when terminate follows a mock %s at once",
    async (method, extraArgs) => {
      const { client, replaced } = makeMockClient();

      const submitted = submit(client, method, extraArgs);
      client.terminate();
      await expect(submitted).rejects.toThrow(/terminated/);
      await client.waitForIdle();
      expect(replaced.free).toHaveBeenCalledTimes(1);
    }
  );

  it.each(mockSubmits)(
    "frees the client a mock %s replaces within its own step",
    async (method, extraArgs) => {
      const { client, replaced } = makeMockClient();
      client.callMethodWithWorker = workerResult();
      const submitted = submit(client, method, extraArgs);
      const queuedBehind = deferred();
      client._serializeWasmCall(() => queuedBehind.promise);

      await expect(submitted).resolves.toBe("tx-id");
      expect(replaced.free).toHaveBeenCalledTimes(1);
      queuedBehind.resolve();
    }
  );

  it.each(mockSubmits)(
    "resolves a mock %s whose replaced client cannot be freed",
    async (method, extraArgs) => {
      const { client, replaced } = makeMockClient();
      client.callMethodWithWorker = workerResult();
      replaced.free = vi.fn(() => {
        throw new Error("still borrowed");
      });

      await expect(submit(client, method, extraArgs)).resolves.toBe("tx-id");
      expect(replaced.free).toHaveBeenCalledTimes(1);
    }
  );

  it.each(mockSubmits)(
    "rejects a mock %s made after terminate",
    async (method, extraArgs) => {
      const { client, replaced } = makeMockClient();
      client.callMethodWithWorker = workerResult();
      client.terminate();

      await expect(submit(client, method, extraArgs)).rejects.toThrow(
        /terminated/
      );
      expect(client.callMethodWithWorker).not.toHaveBeenCalled();
      await client.waitForIdle();
      expect(replaced.free).toHaveBeenCalledTimes(1);
    }
  );
});

describe("MidenClient disposal", () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it("asyncDispose resolves only once the inner client's release has settled", async () => {
    const released = deferred();
    const inner = {
      terminate: vi.fn(),
      waitForIdle: vi.fn(() => released.promise),
    };
    const client = new MidenClient(inner, async () => makeWasm(), null);

    let disposed = false;
    const disposing = client[Symbol.asyncDispose]().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(false);
    expect(inner.terminate).toHaveBeenCalledTimes(1);
    expect(inner.waitForIdle).toHaveBeenCalledTimes(1);

    released.resolve();
    await disposing;
    expect(disposed).toBe(true);
  });

  it("dispose stays synchronous and does not wait", () => {
    const inner = { terminate: vi.fn(), waitForIdle: vi.fn() };
    const client = new MidenClient(inner, async () => makeWasm(), null);

    expect(client[Symbol.dispose]()).toBeUndefined();
    expect(inner.terminate).toHaveBeenCalledTimes(1);
    expect(inner.waitForIdle).not.toHaveBeenCalled();
  });
});
