import { afterEach, describe, expect, it, vi } from "vitest";

const fakeWasm = vi.hoisted(() => {
  const wasm = {
    SyncSummary: {
      deserialize: (bytes) => ({ kind: "sync", length: bytes.length }),
    },
    ProvenTransaction: {
      deserialize: (bytes) => ({ kind: "proven", length: bytes.length }),
    },
    resolveStoreName: (_nodeUrl, storeName) => storeName ?? "default",
  };
  return wasm;
});

vi.mock("../../Cargo.toml", () => ({}));
vi.mock("../wasm.js", () => ({
  default: async () => fakeWasm,
  resolveWasmUrl: async () => undefined,
}));

import { WasmWebClient } from "../index.js";
import { MethodName } from "../constants.js";

class FakeWorker {
  static instances = [];

  constructor() {
    this.posted = [];
    this.listeners = new Map();
    this.terminate = vi.fn();
    FakeWorker.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  postMessage(message) {
    this.posted.push(message);
  }

  emit(type, event) {
    return this.listeners.get(type)?.(event);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createWorkerClient(storeName = "local-reads-store") {
  vi.stubGlobal("Worker", FakeWorker);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const client = new WasmWebClient(
    "https://rpc.example",
    undefined,
    undefined,
    storeName
  );
  const worker = FakeWorker.instances.at(-1);
  worker.emit("message", { data: { loaded: true } });
  worker.emit("message", { data: { ready: true } });
  return { client, worker };
}

const outcomeAfterFlush = (promise) =>
  Promise.race([
    promise.then(
      (value) => ({ status: "resolved", value }),
      (error) => ({ status: "rejected", error })
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve({ status: "pending" }), 20)
    ),
  ]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWorker.instances = [];
});

describe("local reads during worker sync/prove (#567)", () => {
  it("lets a local read resolve while worker syncState is still pending", async () => {
    const { client } = createWorkerClient();
    const gate = deferred();
    let syncHeight = 10;

    vi.spyOn(client, "callMethodWithWorker").mockImplementation(async () => {
      await gate.promise;
      return new Uint8Array([1, 2, 3]);
    });

    const syncPromise = client.syncState();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client._pendingWorkerOps.size).toBe(1);

    const readPromise = client._serializeWasmCall(async () => {
      return syncHeight;
    }, "getSyncHeight");

    await expect(outcomeAfterFlush(readPromise)).resolves.toEqual({
      status: "resolved",
      value: 10,
    });
    expect(await outcomeAfterFlush(syncPromise)).toEqual({ status: "pending" });

    syncHeight = 42;
    gate.resolve();
    await expect(syncPromise).resolves.toEqual({ kind: "sync", length: 3 });

    await expect(
      client._serializeWasmCall(async () => syncHeight, "getSyncHeight")
    ).resolves.toBe(42);
  });

  it("lets a local read resolve while worker proveTransaction is still pending", async () => {
    const { client } = createWorkerClient("local-reads-prove");
    const gate = deferred();

    vi.spyOn(client, "callMethodWithWorker").mockImplementation(async () => {
      await gate.promise;
      return new Uint8Array([9, 9]);
    });

    const transactionResult = { serialize: () => new Uint8Array([4, 5]) };
    const provePromise = client.proveTransaction(transactionResult, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client._pendingWorkerOps.size).toBe(1);

    const readPromise = client._serializeWasmCall(
      async () => "balance",
      "getBalance"
    );
    await expect(outcomeAfterFlush(readPromise)).resolves.toEqual({
      status: "resolved",
      value: "balance",
    });
    expect(await outcomeAfterFlush(provePromise)).toEqual({
      status: "pending",
    });

    gate.resolve();
    await expect(provePromise).resolves.toEqual({ kind: "proven", length: 2 });
  });

  it("keeps importNoteFile behind an in-flight worker sync via the store lock", async () => {
    const { client } = createWorkerClient("local-reads-import");
    const syncGate = deferred();
    const importStarted = deferred();

    vi.spyOn(client, "callMethodWithWorker").mockImplementation(
      async (method) => {
        if (method === MethodName.SYNC_STATE) {
          await syncGate.promise;
          return new Uint8Array([1]);
        }
        importStarted.resolve(method);
        return undefined;
      }
    );

    const syncPromise = client.syncState();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const importPromise = client._withStoreLock(async () => {
      await client.callMethodWithWorker("importNoteFile");
      return "imported";
    }, "importNoteFile");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await outcomeAfterFlush(importStarted.promise)).toEqual({
      status: "pending",
    });

    syncGate.resolve();
    await expect(syncPromise).resolves.toEqual({ kind: "sync", length: 1 });
    await expect(importPromise).resolves.toBe("imported");
    await expect(importStarted.promise).resolves.toBe("importNoteFile");
  });

  it("waitForIdle drains worker-bound sync as well as the call chain", async () => {
    const { client } = createWorkerClient("local-reads-idle");
    const syncGate = deferred();
    const readGate = deferred();

    vi.spyOn(client, "callMethodWithWorker").mockImplementation(async () => {
      await syncGate.promise;
      return new Uint8Array([7]);
    });

    const syncPromise = client.syncState();
    const readPromise = client._serializeWasmCall(
      () => readGate.promise,
      "getAccounts"
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const idle = client.waitForIdle();
    expect(await outcomeAfterFlush(idle)).toEqual({ status: "pending" });

    readGate.resolve("ok");
    await expect(readPromise).resolves.toBe("ok");
    expect(await outcomeAfterFlush(idle)).toEqual({ status: "pending" });

    syncGate.resolve();
    await expect(syncPromise).resolves.toEqual({ kind: "sync", length: 1 });
    await expect(idle).resolves.toBeUndefined();
  });

  it("still serializes two local reads on the main-realm chain", async () => {
    const { client } = createWorkerClient("local-reads-serialize");
    const order = [];
    const firstGate = deferred();

    const first = client._serializeWasmCall(async () => {
      order.push("first-start");
      await firstGate.promise;
      order.push("first-end");
      return 1;
    }, "getSyncHeight");

    const second = client._serializeWasmCall(async () => {
      order.push("second");
      return 2;
    }, "getBalance");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["first-start"]);

    firstGate.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});
