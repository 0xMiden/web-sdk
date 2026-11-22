import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `index.js` re-exports the wasm-bindgen surface from `../Cargo.toml`, which
// the node test environment cannot load, and reaches the wasm module through
// `../wasm.js`; both are stubbed. The stand-in wasm client is past genesis, so
// account creation runs without the store lock, and records its calls.
const fakeWasm = vi.hoisted(() => {
  class WebClient {
    static latest = null;
    constructor() {
      WebClient.latest = this;
      this.free = vi.fn();
      this.createClient = vi.fn(async () => {});
      this.createClientWithExternalKeystore = vi.fn(async () => {});
      this.createMockClient = vi.fn(async () => {});
      this.serializeMockChain = vi.fn(async () => new Uint8Array());
      this.serializeMockNoteTransportNode = vi.fn(async () => new Uint8Array());
      this.getSyncHeight = vi.fn(async () => 5);
      this.newAccount = vi.fn(async () => "account");
    }
  }
  return {
    WebClient,
    resolveStoreName: (nodeUrl, storeName) =>
      storeName ?? `MidenClientDB_${nodeUrl}`,
    TransactionResult: { deserialize: () => ({ id: () => "tx-id" }) },
  };
});
vi.mock("../../Cargo.toml", () => ({}));
vi.mock("../wasm.js", () => ({ default: async () => fakeWasm }));

import { WasmWebClient, MockWasmWebClient } from "../index.js";
import { WorkerAction } from "../constants.js";

// Node has no Worker. This one records what the client posts and lets a test
// dispatch any event type to the client's listeners.
class FakeWorker {
  static instances = [];
  constructor() {
    this.listeners = new Map();
    this.posted = [];
    this.terminate = vi.fn();
    FakeWorker.instances.push(this);
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  postMessage(message) {
    this.posted.push(message);
  }
  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  message(data) {
    this.dispatch("message", { data });
  }
  calls() {
    return this.posted.filter(
      ({ action }) => action === WorkerAction.CALL_METHOD
    );
  }
}

// What a browser fires for a script that fails to load: a plain Event.
const loadFailureEvent = () => ({ type: "error", preventDefault: vi.fn() });
// What a browser fires for an error thrown outside a request: an ErrorEvent.
const runtimeErrorEvent = (error) => ({
  type: "error",
  message: `Uncaught Error: ${error.message}`,
  filename: "worker.js",
  lineno: 12,
  colno: 3,
  error,
  preventDefault: vi.fn(),
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settled = (promise) =>
  Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected"
    ),
    flush()
      .then(flush)
      .then(() => "pending"),
  ]);

const accountId = { toString: () => "0xaccount" };
const request = { serialize: () => new Uint8Array([1]) };

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const factories = [
  [
    "WebClient.createClient",
    () => WasmWebClient.createClient("rpc", undefined, undefined, "store"),
  ],
  [
    "WebClient.createClientWithExternalKeystore",
    () =>
      WasmWebClient.createClientWithExternalKeystore(
        "rpc",
        undefined,
        undefined,
        "store"
      ),
  ],
  ["MockWebClient.createClient", () => MockWasmWebClient.createClient()],
];

describe("a worker that fails to load", () => {
  it.each(factories)(
    "makes %s reject instead of waiting forever",
    async (_name, create) => {
      const creating = create();
      const [worker] = FakeWorker.instances;
      const event = loadFailureEvent();
      worker.dispatch("error", event);

      await expect(creating).rejects.toThrow(
        "WebClient worker failed to load. Check that the worker script and the modules it imports are served."
      );
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(worker.terminate).toHaveBeenCalled();
      await flush();
      expect(fakeWasm.WebClient.latest.free).toHaveBeenCalledTimes(1);
    }
  );

  it("names the error a classic worker script reports", async () => {
    const creating = WasmWebClient.createClient(
      "rpc",
      undefined,
      undefined,
      "store"
    );
    const [worker] = FakeWorker.instances;
    worker.dispatch("error", {
      type: "error",
      message: "Uncaught SyntaxError: Unexpected token '<'",
      filename: "web-client-methods-worker.js",
      lineno: 1,
      colno: 1,
      error: null,
      preventDefault: vi.fn(),
    });

    const error = await creating.catch((caught) => caught);
    expect(error.message).toBe(
      "WebClient worker failed to load: Uncaught SyntaxError: Unexpected token '<' (web-client-methods-worker.js:1:1). Check that the worker script and the modules it imports are served."
    );
    expect(error.cause).toBeUndefined();
  });
});

describe("a worker that throws outside a request", () => {
  // Builds a client whose worker is loaded and ready, the state createClient
  // returns it in.
  async function readyClient() {
    const creating = WasmWebClient.createClient(
      "rpc",
      undefined,
      undefined,
      "store"
    );
    const [worker] = FakeWorker.instances;
    worker.message({ loaded: true });
    worker.message({ ready: true });
    return { client: await creating, worker };
  }

  it("rejects the call in flight and frees the call chain behind it", async () => {
    const { client, worker } = await readyClient();
    const submitting = client.submitNewTransaction(accountId, request);
    const waiting = submitting.catch(() => {});
    await flush();
    expect(worker.calls()).toHaveLength(1);

    const idle = client.waitForIdle();
    const creating = client.newAccount("account-object", false);
    expect(await settled(idle)).toBe("pending");

    const cause = new Error("boom");
    const event = runtimeErrorEvent(cause);
    worker.dispatch("error", event);

    const error = await submitting.catch((caught) => caught);
    expect(error.message).toBe(
      "WebClient worker failed: uncaught error: Uncaught Error: boom (worker.js:12:3)"
    );
    expect(error.cause).toBe(cause);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await waiting;
    await expect(idle).resolves.toBeUndefined();
    await expect(creating).resolves.toBe("account");
    expect(fakeWasm.WebClient.latest.newAccount).toHaveBeenCalledTimes(1);
  });

  it("fails every later worker call at once with the same error", async () => {
    const { client, worker } = await readyClient();
    worker.dispatch("error", runtimeErrorEvent(new Error("boom")));
    const [failure] = console.error.mock.calls
      .find(([label]) => label === "WebClient: worker failed:")
      .slice(1);

    await expect(client.submitNewTransaction(accountId, request)).rejects.toBe(
      failure
    );
    await expect(client.syncState()).rejects.toBe(failure);
    expect(worker.calls()).toHaveLength(0);
  });

  it("keeps the first failure and still lets terminate() release the client", async () => {
    const { client, worker } = await readyClient();
    const pending = client.submitNewTransaction(accountId, request);
    await flush();

    worker.dispatch("error", runtimeErrorEvent(new Error("first")));
    worker.dispatch("messageerror", { type: "messageerror" });
    worker.dispatch("error", runtimeErrorEvent(new Error("second")));

    await expect(pending).rejects.toThrow("Uncaught Error: first");
    expect(worker.terminate).toHaveBeenCalledTimes(1);

    client.terminate();
    await flush();
    expect(fakeWasm.WebClient.latest.free).toHaveBeenCalledTimes(1);
    await expect(client.syncState()).rejects.toThrow("WebClient terminated");
  });

  it("ignores worker events after terminate()", async () => {
    const { client, worker } = await readyClient();
    client.terminate();
    worker.dispatch("error", runtimeErrorEvent(new Error("late")));

    expect(console.error).not.toHaveBeenCalledWith(
      "WebClient: worker failed:",
      expect.anything()
    );
    await expect(client.syncState()).rejects.toThrow("WebClient terminated");
  });

  it("reports an error event without a message by its location only", async () => {
    const { client, worker } = await readyClient();
    const pending = client.submitNewTransaction(accountId, request);
    await flush();
    worker.dispatch("error", {
      type: "error",
      message: "",
      filename: "worker.js",
      lineno: 7,
      colno: 9,
      preventDefault: vi.fn(),
    });

    await expect(pending).rejects.toThrow(
      /^WebClient worker failed: uncaught error \(worker\.js:7:9\)$/
    );
  });
});

describe("a worker reply that cannot be deserialized", () => {
  it("rejects the pending call instead of losing its reply", async () => {
    const creating = WasmWebClient.createClient(
      "rpc",
      undefined,
      undefined,
      "store"
    );
    const [worker] = FakeWorker.instances;
    worker.message({ loaded: true });
    worker.message({ ready: true });
    const client = await creating;
    const pending = client.submitNewTransaction(accountId, request);
    await flush();

    worker.dispatch("messageerror", { type: "messageerror" });

    await expect(pending).rejects.toThrow(
      "WebClient worker failed: it sent a message that could not be deserialized"
    );
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
