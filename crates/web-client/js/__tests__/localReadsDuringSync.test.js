import { afterEach, describe, expect, it, vi } from "vitest";

const fakeWasm = vi.hoisted(() => {
  const wasm = {
    SyncSummary: {
      deserialize: (bytes) => ({ kind: "sync", length: bytes.length }),
    },
    TransactionStoreUpdate: {
      fromResult: (_result, height) => ({ kind: "applied", height }),
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

import { MidenClient } from "../client.js";
import { __createClientProxyForTest, WasmWebClient } from "../index.js";
import { MethodName } from "../constants.js";
import { LOCK_WAIT_TIMEOUT_MS, runUnderLock } from "../syncLock.js";

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
  const proxy = __createClientProxyForTest(client);
  return { client, proxy, worker };
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
  vi.useRealTimers();
  FakeWorker.instances = [];
});

describe("local reads during worker sync/prove (#567)", () => {
  it.each(["syncState", "syncChain", "syncNoteTransport", "proveTransaction"])(
    "lets getSyncHeight resolve while worker %s is pending",
    async (method) => {
      const { client, proxy } = createWorkerClient();
      const started = deferred();
      const release = deferred();
      let height = 10;

      client.wasmWebClient = { getSyncHeight: async () => height };
      vi.spyOn(client, "callMethodWithWorker").mockImplementation(async () => {
        started.resolve();
        await release.promise;
        return new Uint8Array([1]);
      });

      const operation =
        method === "proveTransaction"
          ? proxy.proveTransaction({ serialize: () => new Uint8Array([2]) })
          : proxy[method]();
      await started.promise;
      const read = proxy.getSyncHeight();
      const during = await outcomeAfterFlush(read);
      const progress = await outcomeAfterFlush(operation);
      height = 42;
      release.resolve();

      await operation;
      expect(progress).toEqual({ status: "pending" });
      expect(during).toEqual({ status: "resolved", value: 10 });
      await expect(proxy.getSyncHeight()).resolves.toBe(42);
    }
  );

  it("keeps a second client's import behind worker sync on the same store", async () => {
    const storeName = "local-reads-import";
    const { client, proxy } = createWorkerClient(storeName);
    const { client: importingClient, proxy: importer } =
      createWorkerClient(storeName);
    const lockTails = new Map();
    const request = vi.fn((name, _options, fn) => {
      const granted = (lockTails.get(name) ?? Promise.resolve()).then(fn);
      lockTails.set(
        name,
        granted.catch(() => {})
      );
      return granted;
    });
    vi.stubGlobal("navigator", { locks: { request } });

    const syncStarted = deferred();
    const syncGate = deferred();
    const importStarted = deferred();
    const noteFile = new Uint8Array([2]);
    vi.spyOn(client, "callMethodWithWorker").mockImplementation(async () => {
      syncStarted.resolve();
      await syncGate.promise;
      return new Uint8Array([1]);
    });
    vi.spyOn(importingClient, "getWasmWebClient").mockResolvedValue({
      importNoteFile: async (file) => {
        importStarted.resolve(file);
        return "imported";
      },
    });

    const syncing = proxy.syncState();
    await syncStarted.promise;
    const importing = importer.importNoteFile(noteFile);
    const duringSync = await outcomeAfterFlush(importStarted.promise);
    syncGate.resolve();

    await expect(syncing).resolves.toEqual({ kind: "sync", length: 1 });
    await expect(importing).resolves.toBe("imported");
    expect(duringSync).toEqual({ status: "pending" });
    await expect(importStarted.promise).resolves.toBe(noteFile);
    expect(request.mock.calls.map(([name]) => name)).toEqual([
      `miden-sync-${storeName}`,
      `miden-sync-${storeName}`,
    ]);
  });

  it("does not let a later worker sync overtake a queued note import", async () => {
    const { client } = createWorkerClient("local-reads-write-order");
    const localRead = deferred();
    const started = deferred();
    const order = [];

    vi.spyOn(client, "getWasmWebClient").mockResolvedValue({
      importNoteFile: async () => {
        order.push("import");
      },
    });
    vi.spyOn(client, "callMethodWithWorker").mockImplementation(async () => {
      order.push("sync");
      return new Uint8Array([1]);
    });

    const reading = client._serializeWasmCall(async () => {
      started.resolve();
      await localRead.promise;
    }, "getSyncHeight");
    await started.promise;

    const importing = client.importNoteFile(new Uint8Array([2]));
    const syncing = client.syncState();
    await new Promise((resolve) => setTimeout(resolve, 0));
    localRead.resolve();

    await Promise.all([reading, importing, syncing]);
    expect(order).toEqual(["import", "sync"]);
  });

  it("keeps consumable note screening behind an active store sync", async () => {
    const { client } = createWorkerClient("local-reads-note-snapshot");
    const syncStarted = deferred();
    const syncGate = deferred();
    client.wasmWebClient = { getConsumableNotes: async () => [] };
    const api = new MidenClient(
      __createClientProxyForTest(client),
      async () => fakeWasm
    );
    vi.spyOn(client, "callMethodWithWorker").mockImplementation(async () => {
      syncStarted.resolve();
      await syncGate.promise;
      return new Uint8Array([1]);
    });

    const syncing = client.syncState();
    await syncStarted.promise;

    const screening = api.notes.listConsumable();
    const beforeSync = await outcomeAfterFlush(screening);
    syncGate.resolve();
    await syncing;

    expect(beforeSync).toEqual({ status: "pending" });
    await expect(screening).resolves.toEqual([]);
  });

  it("does not let a later apply overtake sync waiting for the store lock", async () => {
    const { client } = createWorkerClient("local-reads-apply-order");
    const releaseStore = deferred();
    const storeStarted = deferred();
    const order = [];
    const storeUse = runUnderLock(client._storeLockId(), async () => {
      storeStarted.resolve();
      await releaseStore.promise;
    });
    await storeStarted.promise;

    vi.spyOn(client, "callMethodWithWorker").mockImplementation(
      async (method) => {
        order.push(method);
        return new Uint8Array([1]);
      }
    );
    const syncing = client.syncState();
    const applying = client.applyTransaction(
      { serialize: () => new Uint8Array([2]) },
      10
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseStore.resolve();

    await Promise.all([storeUse, syncing, applying]);
    expect(order).toEqual([
      MethodName.SYNC_STATE,
      MethodName.APPLY_TRANSACTION,
    ]);
  });

  it("keeps a sync-height read behind an earlier queued write", async () => {
    const { client } = createWorkerClient("local-reads-after-queued-write");
    const syncStarted = deferred();
    const releaseSync = deferred();
    let height = 10;
    const wasmClient = {
      getSyncHeight: async () => height,
      importNoteFile: async () => {
        height = 42;
      },
    };
    client.wasmWebClient = wasmClient;
    vi.spyOn(client, "getWasmWebClient").mockResolvedValue(wasmClient);
    vi.spyOn(client, "callMethodWithWorker").mockImplementation(async () => {
      syncStarted.resolve();
      await releaseSync.promise;
      return new Uint8Array([1]);
    });

    const proxy = __createClientProxyForTest(client);
    const syncing = proxy.syncState();
    await syncStarted.promise;
    const importing = proxy.importNoteFile(new Uint8Array([2]));
    const reading = proxy.getSyncHeight();
    const beforeSync = await outcomeAfterFlush(reading);
    releaseSync.resolve();

    await Promise.all([syncing, importing]);
    expect(beforeSync).toEqual({ status: "pending" });
    await expect(reading).resolves.toBe(42);
  });

  it("waitForIdle drains the ordered worker call and admitted sync-height read", async () => {
    const { client, proxy } = createWorkerClient("local-reads-idle");
    const syncStarted = deferred();
    const syncGate = deferred();
    const readGate = deferred();

    client.wasmWebClient = { getSyncHeight: () => readGate.promise };
    vi.spyOn(client, "callMethodWithWorker").mockImplementation(async () => {
      syncStarted.resolve();
      await syncGate.promise;
      return new Uint8Array([7]);
    });

    const syncing = proxy.syncState();
    await syncStarted.promise;
    const reading = proxy.getSyncHeight();
    const idle = proxy.waitForIdle();
    const beforeSync = await outcomeAfterFlush(idle);
    syncGate.resolve();
    await syncing;
    const afterSync = await outcomeAfterFlush(idle);
    readGate.resolve(10);

    expect(beforeSync).toEqual({ status: "pending" });
    expect(afterSync).toEqual({ status: "pending" });
    await expect(reading).resolves.toBe(10);
    await expect(idle).resolves.toBeUndefined();
  });

  it("serializes admitted reads and drains them before an ordered main-realm write", async () => {
    const { client, proxy } = createWorkerClient("local-reads-drain");
    const syncStarted = deferred();
    const syncGate = deferred();
    const firstRead = deferred();
    const order = [];
    const wasmClient = {
      getSyncHeight: vi
        .fn()
        .mockImplementationOnce(async () => {
          order.push("first read");
          return firstRead.promise;
        })
        .mockImplementationOnce(async () => {
          order.push("second read");
          return 10;
        }),
      importNoteFile: async () => {
        order.push("write");
      },
    };
    client.wasmWebClient = wasmClient;
    vi.spyOn(client, "getWasmWebClient").mockResolvedValue(wasmClient);
    vi.spyOn(client, "callMethodWithWorker").mockImplementation(async () => {
      syncStarted.resolve();
      await syncGate.promise;
      return new Uint8Array([1]);
    });

    const syncing = proxy.syncState();
    await syncStarted.promise;
    const first = proxy.getSyncHeight();
    const second = proxy.getSyncHeight();
    const importing = proxy.importNoteFile(new Uint8Array([2]));
    syncGate.resolve();
    await syncing;
    const beforeRead = await outcomeAfterFlush(importing);
    const beforeRelease = [...order];
    firstRead.resolve(10);

    await Promise.all([first, second, importing]);
    expect(beforeRead).toEqual({ status: "pending" });
    expect(beforeRelease).toEqual(["first read"]);
    expect(order).toEqual(["first read", "second read", "write"]);
  });

  it("keeps accountReader ordered while a worker sync is active", async () => {
    const { client, proxy } = createWorkerClient("local-reads-account-reader");
    const syncStarted = deferred();
    const releaseSync = deferred();
    const reader = {};
    client.wasmWebClient = { accountReader: vi.fn(async () => reader) };
    vi.spyOn(client, "callMethodWithWorker").mockImplementation(async () => {
      syncStarted.resolve();
      await releaseSync.promise;
      return new Uint8Array([1]);
    });

    const syncing = proxy.syncState();
    await syncStarted.promise;
    const reading = proxy.accountReader("account");
    const during = await outcomeAfterFlush(reading);
    releaseSync.resolve();

    await syncing;
    expect(during).toEqual({ status: "pending" });
    await expect(reading).resolves.toBe(reader);
  });

  it("waits for an admitted sync-height read before freeing the WASM client", async () => {
    const { client, proxy } = createWorkerClient("local-reads-terminate");
    const readStarted = deferred();
    const releaseRead = deferred();
    class FakeWasmClient {
      free = vi.fn();

      async getSyncHeight() {
        readStarted.resolve();
        return releaseRead.promise;
      }
    }
    const wasmClient = new FakeWasmClient();
    client.wasmWebClient = wasmClient;

    const syncing = proxy.syncState().catch((error) => error);
    await vi.waitFor(() => expect(client.pendingRequests.size).toBe(1));
    const reading = proxy.getSyncHeight();
    const started = await outcomeAfterFlush(readStarted.promise);
    proxy.terminate();
    const idle = proxy.waitForIdle();
    const beforeRead = await outcomeAfterFlush(idle);
    const wasFreed = wasmClient.free.mock.calls.length;
    const rejected = proxy.getSyncHeight().catch((error) => error);
    releaseRead.resolve(10);

    expect(started).toEqual({ status: "resolved", value: undefined });
    expect(await syncing).toHaveProperty("message", "WebClient terminated");
    expect(beforeRead).toEqual({ status: "pending" });
    expect(wasFreed).toBe(0);
    expect(await rejected).toHaveProperty("message", "WebClient terminated");
    await expect(reading).resolves.toBe(10);
    await idle;
    expect(wasmClient.free).toHaveBeenCalledTimes(1);
  });

  it("returns to ordered reads after a worker fails mid-sync", async () => {
    const { client, proxy, worker } = createWorkerClient("local-reads-failure");
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const wasmClient = {
      getSyncHeight: async () => 10,
      importNoteFile: async () => {
        writeStarted.resolve();
        await releaseWrite.promise;
      },
    };
    client.wasmWebClient = wasmClient;
    vi.spyOn(client, "getWasmWebClient").mockResolvedValue(wasmClient);

    const syncing = proxy.syncState().catch((error) => error);
    await vi.waitFor(() => expect(client.pendingRequests.size).toBe(1));
    const initialRead = proxy.getSyncHeight();
    const beforeFailure = await outcomeAfterFlush(initialRead);
    worker.emit("error", { message: "forced test failure" });
    expect(await syncing).toBe(client.workerFailure);
    expect(beforeFailure).toEqual({ status: "resolved", value: 10 });
    await expect(initialRead).resolves.toBe(10);
    expect(client._workerOnlyTurn).toBeFalsy();

    const importing = proxy.importNoteFile(new Uint8Array([2]));
    await writeStarted.promise;
    const reading = proxy.getSyncHeight();
    const duringWrite = await outcomeAfterFlush(reading);
    releaseWrite.resolve();

    await importing;
    expect(duringWrite).toEqual({ status: "pending" });
    await expect(reading).resolves.toBe(10);
  });

  it("runs trusted nested sync inline without admitting an unrelated read", async () => {
    const { client, proxy } = createWorkerClient("local-reads-trusted");
    const syncStarted = deferred();
    const releaseSync = deferred();
    client.wasmWebClient = { getSyncHeight: async () => 10 };
    vi.spyOn(client, "callMethodWithWorker").mockImplementation(async () => {
      syncStarted.resolve();
      return releaseSync.promise;
    });
    const api = new MidenClient(proxy, async () => fakeWasm);

    const syncing = api._withInnerWebClient((trusted) => trusted.syncState());
    await syncStarted.promise;
    const reading = proxy.getSyncHeight();
    const during = await outcomeAfterFlush(reading);
    releaseSync.resolve(new Uint8Array([1]));

    await syncing;
    expect(during).toEqual({ status: "pending" });
    await expect(reading).resolves.toBe(10);
  });

  it("closes a sync join window when a sync-height read is admitted", async () => {
    const { client, proxy } = createWorkerClient("local-reads-join");
    const syncStarted = deferred();
    const releaseSync = deferred();
    client.wasmWebClient = { getSyncHeight: async () => 10 };
    const workerCall = vi
      .spyOn(client, "callMethodWithWorker")
      .mockImplementationOnce(async () => {
        syncStarted.resolve();
        return releaseSync.promise;
      })
      .mockResolvedValueOnce(new Uint8Array([1, 2]));

    const first = proxy.syncState();
    await syncStarted.promise;
    const joiner = proxy.syncState();
    const reading = proxy.getSyncHeight();
    const second = proxy.syncState();
    const during = await outcomeAfterFlush(reading);
    releaseSync.resolve(new Uint8Array([1]));

    await expect(first).resolves.toEqual({ kind: "sync", length: 1 });
    await expect(joiner).resolves.toEqual({ kind: "sync", length: 1 });
    expect(during).toEqual({ status: "resolved", value: 10 });
    await expect(second).resolves.toEqual({ kind: "sync", length: 2 });
    expect(workerCall).toHaveBeenCalledTimes(2);
  });

  it("keeps the worker sync lock deadline when an eligible read is admitted", async () => {
    vi.useFakeTimers();
    const storeName = "local-reads-lock-timeout";
    const { client, proxy } = createWorkerClient(storeName);
    const held = deferred();
    const release = deferred();
    const storeUse = runUnderLock(client._storeLockId(), () => {
      held.resolve();
      return release.promise;
    });
    await held.promise;
    client.wasmWebClient = { getSyncHeight: async () => 10 };
    const workerCall = vi.spyOn(client, "callMethodWithWorker");
    const syncing = proxy.syncState().catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);

    const onRead = vi.fn();
    const reading = proxy.getSyncHeight().then(onRead);
    await vi.advanceTimersByTimeAsync(0);
    const readDuringLock = onRead.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LOCK_WAIT_TIMEOUT_MS);
    const error = await syncing;
    release.resolve();

    await storeUse;
    expect(error.message).toBe(
      `Timed out after ${LOCK_WAIT_TIMEOUT_MS} ms waiting for the sync lock of ${storeName}`
    );
    await reading;
    expect(readDuringLock).toBe(1);
    expect(onRead).toHaveBeenCalledWith(10);
    expect(workerCall).not.toHaveBeenCalled();
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
