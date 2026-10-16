import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetObserverForTest, setObserver } from "../observability.js";

const fakeWasm = vi.hoisted(() => ({
  WebClient: class {},
  SyncSummary: { deserialize: (bytes) => `summary ${bytes.length}` },
  AuthScheme: Object.freeze({ AuthRpoFalcon512: 2, 2: "AuthRpoFalcon512" }),
}));
vi.mock("../../Cargo.toml", () => ({}));
vi.mock("../wasm.js", () => ({ default: async () => fakeWasm }));

import { MidenClient } from "../client.js";
import {
  WasmWebClient,
  MockWasmWebClient,
  __createClientProxyForTest as createClientProxy,
} from "../index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

let storeCounter = 0;
function uniqueStore() {
  return `test-store-lock-${++storeCounter}-${Date.now()}`;
}

// Every wasm call records when it starts and ends, and stays parked until the
// test releases it by its label: "<client>.<method>[ <first argument>]".
const events = [];
const parked = new Map();

function makeWasmClient(name) {
  const call = (method) =>
    vi.fn(async (...args) => {
      const label =
        args[0] === undefined
          ? `${name}.${method}`
          : `${name}.${method} ${args[0]}`;
      events.push(`start ${label}`);
      await new Promise((resolve) => parked.set(label, resolve));
      events.push(`end ${label}`);
      return label;
    });
  return {
    free: vi.fn(),
    syncStateImpl: call("syncState"),
    syncChainImpl: call("syncChain"),
    syncNoteTransportImpl: call("syncNoteTransport"),
    importNoteFile: call("importNoteFile"),
    fetchPrivateNotes: call("fetchPrivateNotes"),
    newWallet: call("newWallet"),
    newFaucet: call("newFaucet"),
    newAccount: call("newAccount"),
    newAccountWithSecretKey: call("newAccountWithSecretKey"),
    executeTransaction: call("executeTransaction"),
  };
}

function makeWebClient(storeName, name, { mock = false } = {}) {
  const instance = mock
    ? new MockWasmWebClient()
    : new WasmWebClient(
        undefined,
        undefined,
        undefined,
        storeName,
        undefined,
        undefined,
        undefined,
        undefined,
        false
      );
  const wasmClient = makeWasmClient(name);
  instance.wasmWebClient = wasmClient;
  instance.wasmWebClientPromise = Promise.resolve(wasmClient);
  return { instance, client: createClientProxy(instance), wasmClient };
}

async function waitForStart(label) {
  await vi.waitFor(() => expect(parked.has(label)).toBe(true));
}

async function release(label) {
  await waitForStart(label);
  const resolve = parked.get(label);
  parked.delete(label);
  resolve();
}

// Lets every queued microtask and lock grant run.
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

const state = (promise) =>
  Promise.race([
    promise.then(
      () => "resolved",
      (error) => `rejected: ${error.message}`
    ),
    flush().then(() => "pending"),
  ]);

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

// An exclusive, first-come Web Locks stand-in. Like a browser, it grants a
// request in a later macrotask, never in the task that made it.
function installWebLocks() {
  const tails = new Map();
  const request = vi.fn((name, _options, fn) => {
    const granted = (tails.get(name) ?? Promise.resolve())
      .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
      .then(() => fn());
    tails.set(
      name,
      granted.then(
        () => {},
        () => {}
      )
    );
    return granted;
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request } },
  });
  return request;
}

let origNavigator;
let lockRequest;

beforeEach(() => {
  origNavigator = globalThis.navigator;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  // Drain whatever a failed test left parked, including calls queued behind it.
  for (let i = 0; i < 20 && parked.size > 0; i++) {
    for (const resolve of parked.values()) resolve();
    parked.clear();
    await flush();
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: origNavigator,
  });
  events.length = 0;
  __resetObserverForTest();
  vi.restoreAllMocks();
});

// ── Web Locks path ────────────────────────────────────────────────────────────

describe("store lock across WebClient instances (Web Locks)", () => {
  beforeEach(() => {
    lockRequest = installWebLocks();
  });

  it("runs an import on one client only after another client's sync on the same store", async () => {
    const seen = [];
    setObserver((observation) => seen.push(observation.op));
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const b = makeWebClient(store, "B");

    const sync = a.client.syncState();
    await waitForStart("A.syncState");
    const imported = b.client.importNoteFile("f1");
    await flush();
    expect(events).toEqual(["start A.syncState"]);

    await release("A.syncState");
    await release("B.importNoteFile f1");
    await expect(sync).resolves.toBe("A.syncState");
    await expect(imported).resolves.toBe("B.importNoteFile f1");
    expect(events).toEqual([
      "start A.syncState",
      "end A.syncState",
      "start B.importNoteFile f1",
      "end B.importNoteFile f1",
    ]);
    expect(seen).toEqual(["syncState", "importNoteFile"]);
    expect(lockRequest.mock.calls.map(([name]) => name)).toEqual([
      `miden-sync-${store}`,
      `miden-sync-${store}`,
    ]);
  });

  it("runs a sync on one client only after another client's private-note fetch on the same store", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const b = makeWebClient(store, "B");

    const fetched = a.client.fetchPrivateNotes();
    await waitForStart("A.fetchPrivateNotes");
    const synced = b.client.syncChain();
    await flush();
    expect(events).toEqual(["start A.fetchPrivateNotes"]);

    await release("A.fetchPrivateNotes");
    await release("B.syncChain");
    await expect(fetched).resolves.toBe("A.fetchPrivateNotes");
    await expect(synced).resolves.toBe("B.syncChain");
    expect(events).toEqual([
      "start A.fetchPrivateNotes",
      "end A.fetchPrivateNotes",
      "start B.syncChain",
      "end B.syncChain",
    ]);
  });

  it("queues imports one after another instead of sharing a run, while concurrent syncs still share one", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const b = makeWebClient(store, "B");

    const first = a.client.importNoteFile("f1");
    const second = b.client.importNoteFile("f2");
    await waitForStart("A.importNoteFile f1");
    await flush();
    expect(events).toEqual(["start A.importNoteFile f1"]);

    await release("A.importNoteFile f1");
    await release("B.importNoteFile f2");
    await expect(first).resolves.toBe("A.importNoteFile f1");
    await expect(second).resolves.toBe("B.importNoteFile f2");
    expect(a.wasmClient.importNoteFile).toHaveBeenCalledWith("f1");
    expect(b.wasmClient.importNoteFile).toHaveBeenCalledWith("f2");

    const syncs = [a.client.syncState(), b.client.syncState()];
    await release("A.syncState");
    await expect(Promise.all(syncs)).resolves.toEqual([
      "A.syncState",
      "A.syncState",
    ]);
    expect(b.wasmClient.syncStateImpl).not.toHaveBeenCalled();
  });

  it("keys the lock by store, so a client on another store does not wait", async () => {
    const store = uniqueStore();
    const otherStore = uniqueStore();
    const a = makeWebClient(store, "A");
    const b = makeWebClient(otherStore, "B");
    const c = makeWebClient(store, "C");

    const sync = a.client.syncState();
    await waitForStart("A.syncState");
    const sameStore = c.client.importNoteFile("f1");
    const otherStoreImport = b.client.importNoteFile("f2");
    await waitForStart("B.importNoteFile f2");
    expect(events).toEqual(["start A.syncState", "start B.importNoteFile f2"]);

    await release("B.importNoteFile f2");
    await release("A.syncState");
    await release("C.importNoteFile f1");
    await Promise.all([sync, sameStore, otherStoreImport]);
    expect(lockRequest.mock.calls.map(([name]) => name).sort()).toEqual(
      [
        `miden-sync-${store}`,
        `miden-sync-${store}`,
        `miden-sync-${otherStore}`,
      ].sort()
    );
  });

  it("routes notes.import and notes.fetchPrivate on a MidenClient through the lock", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const b = makeWebClient(store, "B");
    const midenB = new MidenClient(b.client, async () => fakeWasm, null);

    const sync = a.client.syncState();
    await waitForStart("A.syncState");
    const imported = midenB.notes.import("f1");
    const fetched = midenB.notes.fetchPrivate();
    await flush();
    expect(events).toEqual(["start A.syncState"]);

    await release("A.syncState");
    await release("B.importNoteFile f1");
    await release("B.fetchPrivateNotes");
    await expect(imported).resolves.toBe("B.importNoteFile f1");
    await expect(fetched).resolves.toBeUndefined();
    await sync;
    expect(events).toEqual([
      "start A.syncState",
      "end A.syncState",
      "start B.importNoteFile f1",
      "end B.importNoteFile f1",
      "start B.fetchPrivateNotes",
      "end B.fetchPrivateNotes",
    ]);
  });

  it("runs account creation, whose first sync writes the chain MMR, only after another client's sync", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const b = makeWebClient(store, "B");

    const sync = a.client.syncState();
    await waitForStart("A.syncState");
    const created = [
      b.client.newWallet("private", "falcon"),
      b.client.newFaucet("private", false, "T", "TOK", 8, 1n, "falcon"),
      b.client.newAccount("account", false),
      b.client.newAccountWithSecretKey("keyed", "key"),
    ];
    await flush();
    expect(events).toEqual(["start A.syncState"]);

    await release("A.syncState");
    for (const label of [
      "B.newWallet private",
      "B.newFaucet private",
      "B.newAccount account",
      "B.newAccountWithSecretKey keyed",
    ]) {
      await release(label);
    }
    await Promise.all([sync, ...created]);
    expect(events.indexOf("end A.syncState")).toBeLessThan(
      events.indexOf("start B.newWallet private")
    );
  });

  it("holds the lock across a worker-mode sync", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const b = makeWebClient(store, "B");
    const worker = { postMessage: vi.fn(), terminate: vi.fn() };
    a.instance.worker = worker;
    a.instance.pendingRequests = new Map();
    a.instance.ready = Promise.resolve();

    const sync = a.client.syncState();
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    const imported = b.client.importNoteFile("f1");
    await flush();
    expect(events).toEqual([]);

    const { requestId } = worker.postMessage.mock.calls[0][0];
    a.instance.pendingRequests.get(requestId).resolve([1, 2, 3]);
    await expect(sync).resolves.toBe("summary 3");
    await release("B.importNoteFile f1");
    await expect(imported).resolves.toBe("B.importNoteFile f1");
  });

  it("runs a mock client's import only after another mock client's sync", async () => {
    const a = makeWebClient(undefined, "A", { mock: true });
    const b = makeWebClient(undefined, "B", { mock: true });

    const sync = a.client.syncChain();
    await waitForStart("A.syncChain");
    const imported = b.client.importNoteFile("f1");
    await flush();
    expect(events).toEqual(["start A.syncChain"]);

    await release("A.syncChain");
    await release("B.importNoteFile f1");
    await Promise.all([sync, imported]);
    expect(lockRequest.mock.calls.map(([name]) => name)).toEqual([
      "miden-sync-mock_client_db",
      "miden-sync-mock_client_db",
    ]);
  });

  it("makes an import nested in _withInnerWebClient wait for another client's holder", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const b = makeWebClient(store, "B");
    const midenB = new MidenClient(b.client, async () => fakeWasm, null);

    const sync = a.client.syncState();
    await waitForStart("A.syncState");
    const nested = midenB._withInnerWebClient((inner) =>
      inner.importNoteFile("f1")
    );
    await flush();
    expect(events).toEqual(["start A.syncState"]);

    await release("A.syncState");
    await release("B.importNoteFile f1");
    await expect(nested).resolves.toBe("B.importNoteFile f1");
    await sync;
  });

  it("runs calls nested in _withInnerWebClient, then the client's call queued behind the callback, without deadlocking", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const midenA = new MidenClient(a.client, async () => fakeWasm, null);

    // The escape hatch queues behind a running call, and a sync of the same
    // client queues behind the escape hatch.
    const running = deferred();
    a.instance._serializeWasmCall(() => running.promise);
    const hatch = midenA._withInnerWebClient(async (inner) => {
      await inner.importNoteFile("f1");
      await inner.syncChain();
      return "hatch";
    });
    const sync = a.client.syncState();
    await flush();
    expect(events).toEqual([]);

    running.resolve();
    await release("A.importNoteFile f1");
    await release("A.syncChain");
    await expect(hatch).resolves.toBe("hatch");
    await release("A.syncState");
    await expect(sync).resolves.toBe("A.syncState");
    expect(events).toEqual([
      "start A.importNoteFile f1",
      "end A.importNoteFile f1",
      "start A.syncChain",
      "end A.syncChain",
      "start A.syncState",
      "end A.syncState",
    ]);
  });

  it("runs a sync nested in _withInnerWebClient on its own while the same sync of the client is queued behind the callback", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const midenA = new MidenClient(a.client, async () => fakeWasm, null);

    const running = deferred();
    a.instance._serializeWasmCall(() => running.promise);
    const hatch = midenA._withInnerWebClient(
      async (inner) => `hatch ${await inner.syncState()}`
    );
    const queued = a.client.syncState();
    await flush();

    running.resolve();
    await release("A.syncState");
    await expect(hatch).resolves.toBe("hatch A.syncState");
    await release("A.syncState");
    await expect(queued).resolves.toBe("A.syncState");
    expect(a.wasmClient.syncStateImpl).toHaveBeenCalledTimes(2);
  });

  it("runs an import made in the same tick before an _withInnerWebClient callback before the callback starts", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const midenA = new MidenClient(a.client, async () => fakeWasm, null);

    const imported = a.client.importNoteFile("f1");
    const hatch = midenA._withInnerWebClient(async () => {
      events.push("start callback");
      await flush();
      events.push("end callback");
      return "hatch";
    });
    await flush();
    await release("A.importNoteFile f1");
    await expect(imported).resolves.toBe("A.importNoteFile f1");
    await expect(hatch).resolves.toBe("hatch");
    expect(events).toEqual([
      "start A.importNoteFile f1",
      "end A.importNoteFile f1",
      "start callback",
      "end callback",
    ]);
  });

  it("runs account creation and an un-awaited transaction made after it in call order", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");

    const created = a.client.newAccount("account", false);
    const executed = a.client.executeTransaction("acc", "request");
    await flush();
    expect(events).toEqual(["start A.newAccount account"]);

    await release("A.newAccount account");
    await release("A.executeTransaction acc");
    await expect(created).resolves.toBe("A.newAccount account");
    await expect(executed).resolves.toBe("A.executeTransaction acc");
    expect(events).toEqual([
      "start A.newAccount account",
      "end A.newAccount account",
      "start A.executeTransaction acc",
      "end A.executeTransaction acc",
    ]);
  });

  it("resolves a live client joining a sync whose owner was terminated while it waited for the lock", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const b = makeWebClient(store, "B");
    const c = makeWebClient(store, "C");

    const holder = c.client.syncChain();
    await waitForStart("C.syncChain");
    const owned = a.client.syncState();
    await flush();
    a.instance.terminate();
    const joined = b.client.syncState();
    await release("C.syncChain");
    await holder;

    expect(await state(joined)).toBe("pending");
    await release("A.syncState");
    await expect(joined).resolves.toBe("A.syncState");
    await expect(owned).resolves.toBe("A.syncState");
    expect(b.wasmClient.syncStateImpl).not.toHaveBeenCalled();
    await a.instance.waitForIdle();
    expect(a.wasmClient.free).toHaveBeenCalledTimes(1);
  });

  it("drains a call queued before terminate, frees the client only after it, and takes no lock afterwards", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const b = makeWebClient(store, "B");

    const sync = a.client.syncState();
    await waitForStart("A.syncState");
    const imported = b.client.importNoteFile("f1");
    await flush();
    b.instance.terminate();
    const idle = b.instance.waitForIdle();
    await release("A.syncState");
    await sync;

    expect(await state(imported)).toBe("pending");
    await waitForStart("B.importNoteFile f1");
    expect(await state(idle)).toBe("pending");
    expect(b.wasmClient.free).not.toHaveBeenCalled();
    await release("B.importNoteFile f1");
    await expect(imported).resolves.toBe("B.importNoteFile f1");
    await idle;
    expect(b.wasmClient.free).toHaveBeenCalledTimes(1);

    const requests = lockRequest.mock.calls.length;
    await expect(b.client.fetchPrivateNotes()).rejects.toThrow(
      "WebClient terminated"
    );
    expect(lockRequest).toHaveBeenCalledTimes(requests);

    // Nor does it share a live client's run.
    const live = a.client.syncState();
    expect(await state(b.client.syncState())).toBe(
      "rejected: WebClient terminated"
    );
    await release("A.syncState");
    await expect(live).resolves.toBe("A.syncState");
  });
});

// ── no Web Locks: in-process per-store chain ──────────────────────────────────

describe("store lock across WebClient instances (no Web Locks)", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
  });

  it("runs an import only after another client's sync on the same store in this realm", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const b = makeWebClient(store, "B");

    const sync = a.client.syncNoteTransport();
    await waitForStart("A.syncNoteTransport");
    const imported = b.client.importNoteFile("f1");
    const second = a.client.importNoteFile("f2");
    await flush();
    expect(events).toEqual(["start A.syncNoteTransport"]);

    await release("A.syncNoteTransport");
    await release("B.importNoteFile f1");
    await release("A.importNoteFile f2");
    await Promise.all([sync, imported, second]);
    expect(events).toEqual([
      "start A.syncNoteTransport",
      "end A.syncNoteTransport",
      "start B.importNoteFile f1",
      "end B.importNoteFile f1",
      "start A.importNoteFile f2",
      "end A.importNoteFile f2",
    ]);
  });
});
