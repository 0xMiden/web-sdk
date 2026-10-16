import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetObserverForTest, setObserver } from "../observability.js";

const fakeWasm = vi.hoisted(() => {
  const wasm = {
    // The wasm client a factory's `new WebClient()` builds next.
    nextClients: [],
    WebClient: class {
      constructor() {
        return wasm.nextClients.shift() ?? this;
      }
    },
    SyncSummary: { deserialize: (bytes) => `summary ${bytes.length}` },
    AuthScheme: Object.freeze({ AuthRpoFalcon512: 2, 2: "AuthRpoFalcon512" }),
    // Names the store a client opens: the name given, else one per node URL.
    // Throws `storeNameFailure` instead when a test sets it.
    storeNameFailure: null,
    resolveStoreName: (nodeUrl, storeName) => {
      if (wasm.storeNameFailure) throw wasm.storeNameFailure;
      return storeName ?? `MidenClientDB_${nodeUrl}`;
    },
  };
  return wasm;
});
vi.mock("../../Cargo.toml", () => ({}));
vi.mock("../wasm.js", () => ({ default: async () => fakeWasm }));

import { AsyncLock } from "../asyncLock.js";
import { MidenClient } from "../client.js";
import {
  WasmWebClient,
  MockWasmWebClient,
  withSyncLock,
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

function parkedCall(name, method) {
  return vi.fn(async (...args) => {
    const label =
      args[0] === undefined
        ? `${name}.${method}`
        : `${name}.${method} ${args[0]}`;
    events.push(`start ${label}`);
    await new Promise((resolve) => parked.set(label, resolve));
    events.push(`end ${label}`);
    return label;
  });
}

function makeWasmClient(name) {
  const call = (method) => parkedCall(name, method);
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
    getAccounts: call("getAccounts"),
    // The sync height read and the genesis sync account creation runs first
    // return at once and record nothing, so a creation's events are its create
    // call's. The store is at genesis unless a test says otherwise.
    getSyncHeight: vi.fn(async () => 0),
    syncBeforeAccountCreation: vi.fn(async () => {}),
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

// Builds a client through a factory, as an application does.
function createWebClient(name, rpcUrl, storeName, factory = "createClient") {
  const wasmClient = makeWasmClient(name);
  wasmClient.createClient = vi.fn(async () => {});
  wasmClient.createClientWithExternalKeystore = vi.fn(async () => {});
  fakeWasm.nextClients.push(wasmClient);
  const created =
    factory === "createClient"
      ? WasmWebClient.createClient(
          rpcUrl,
          undefined,
          undefined,
          storeName,
          undefined,
          false
        )
      : WasmWebClient.createClientWithExternalKeystore(
          rpcUrl,
          undefined,
          undefined,
          storeName,
          undefined,
          undefined,
          undefined,
          undefined,
          false
        );
  return { created, wasmClient };
}

// Puts a client in worker mode, behind a worker that answers nothing.
function inWorkerMode(instance) {
  const worker = { postMessage: vi.fn(), terminate: vi.fn() };
  Object.assign(instance, {
    worker,
    pendingRequests: new Map(),
    ready: Promise.resolve(),
    readyRejecter: () => {},
  });
  return worker;
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

// The names of the locks the stand-in below has granted and not yet released.
const heldLocks = new Set();

// An exclusive, first-come Web Locks stand-in. Like a browser, it grants a
// request in a later macrotask, never in the task that made it.
function installWebLocks() {
  const tails = new Map();
  const request = vi.fn((name, _options, fn) => {
    const granted = (tails.get(name) ?? Promise.resolve())
      .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
      .then(async () => {
        heldLocks.add(name);
        try {
          return await fn();
        } finally {
          heldLocks.delete(name);
        }
      });
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
  heldLocks.clear();
  fakeWasm.nextClients.length = 0;
  fakeWasm.storeNameFailure = null;
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

  it("queues imports, and the same sync on two clients, one after another instead of sharing a run", async () => {
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
    await expect(syncs[0]).resolves.toBe("A.syncState");
    expect(await state(syncs[1])).toBe("pending");
    await release("B.syncState");
    await expect(syncs[1]).resolves.toBe("B.syncState");
    expect(a.wasmClient.syncStateImpl).toHaveBeenCalledTimes(1);
    expect(b.wasmClient.syncStateImpl).toHaveBeenCalledTimes(1);
  });

  const coalescingSyncs = [
    { name: "syncState", method: "syncState", mock: false },
    { name: "syncChain", method: "syncChain", mock: false },
    { name: "syncNoteTransport", method: "syncNoteTransport", mock: false },
    { name: "MockWebClient syncState", method: "syncState", mock: true },
    { name: "MockWebClient syncChain", method: "syncChain", mock: true },
    {
      name: "MockWebClient syncNoteTransport",
      method: "syncNoteTransport",
      mock: true,
    },
  ];

  it.each(coalescingSyncs)(
    "runs $name on a second client on the store as its own run after the first client's, never joining it",
    async ({ method, mock }) => {
      const store = mock ? undefined : uniqueStore();
      const a = makeWebClient(store, "A", { mock });
      const b = makeWebClient(store, "B", { mock });

      const first = a.client[method]();
      await waitForStart(`A.${method}`);
      const second = b.client[method]();
      await flush();
      expect(events).toEqual([`start A.${method}`]);

      await release(`A.${method}`);
      await first;
      expect(await state(second)).toBe("pending");
      await release(`B.${method}`);
      await second;
      expect(events).toEqual([
        `start A.${method}`,
        `end A.${method}`,
        `start B.${method}`,
        `end B.${method}`,
      ]);
      expect(b.wasmClient[`${method}Impl`]).toHaveBeenCalledTimes(1);
    }
  );

  it("shares one run among a client's concurrent calls of the same sync, and waitForIdle on that client waits for it", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");

    const first = a.client.syncState();
    const second = a.client.syncState();
    const idle = a.instance.waitForIdle();
    await waitForStart("A.syncState");
    expect(await state(idle)).toBe("pending");

    await release("A.syncState");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "A.syncState",
      "A.syncState",
    ]);
    await idle;
    expect(a.wasmClient.syncStateImpl).toHaveBeenCalledTimes(1);
    expect(lockRequest).toHaveBeenCalledTimes(1);
  });

  it("shares a client's running sync with a later call of it when nothing was queued on the client in between", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");

    const first = a.client.syncState();
    await waitForStart("A.syncState");
    const second = a.client.syncState();
    await flush();

    await release("A.syncState");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "A.syncState",
      "A.syncState",
    ]);
    expect(a.wasmClient.syncStateImpl).toHaveBeenCalledTimes(1);
  });

  it("runs a sync called after another call was queued on its client as its own run, behind that call", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");

    const first = a.client.syncState();
    await waitForStart("A.syncState");
    const imported = a.client.importNoteFile("f1");
    const second = a.client.syncState();
    await flush();

    await release("A.syncState");
    await expect(first).resolves.toBe("A.syncState");
    expect(await state(second)).toBe("pending");
    await release("A.importNoteFile f1");
    await expect(imported).resolves.toBe("A.importNoteFile f1");
    await release("A.syncState");
    await expect(second).resolves.toBe("A.syncState");
    expect(events).toEqual([
      "start A.syncState",
      "end A.syncState",
      "start A.importNoteFile f1",
      "end A.importNoteFile f1",
      "start A.syncState",
      "end A.syncState",
    ]);
    expect(a.wasmClient.syncStateImpl).toHaveBeenCalledTimes(2);
  });

  it.each(coalescingSyncs)(
    "rejects $name called again on a terminated client instead of joining its queued run, which still settles",
    async ({ method, mock }) => {
      const store = mock ? undefined : uniqueStore();
      const a = makeWebClient(store, "A", { mock });
      const holder = makeWebClient(store, "H", { mock });

      const held = holder.client.importNoteFile("held");
      await waitForStart("H.importNoteFile held");
      const queued = a.client[method]();
      await flush();
      a.instance.terminate();
      const again = a.client[method]();
      again.catch(() => {});

      await release("H.importNoteFile held");
      await held;
      await release(`A.${method}`);
      await queued;
      await expect(again).rejects.toThrow("WebClient terminated");
      expect(a.wasmClient[`${method}Impl`]).toHaveBeenCalledTimes(1);
    }
  );

  it("runs a live client's sync as its own run when a worker-mode client with the same sync queued is terminated", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const b = makeWebClient(store, "B");
    const c = makeWebClient(store, "C");
    inWorkerMode(a.instance);

    const holder = c.client.syncChain();
    await waitForStart("C.syncChain");
    const owned = a.client.syncState();
    owned.catch(() => {});
    await flush();
    const own = b.client.syncState();
    own.catch(() => {});
    await flush();
    a.instance.terminate();
    await release("C.syncChain");
    await holder;

    await expect(owned).rejects.toThrow("WebClient terminated");
    expect(await state(own)).toBe("pending");
    await release("B.syncState");
    await expect(own).resolves.toBe("B.syncState");
    expect(b.wasmClient.syncStateImpl).toHaveBeenCalledTimes(1);
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

  it("keys the lock by the store a client opens, so a client omitting storeName and one naming that store take one lock", async () => {
    const rpcUrl = "http://node-a";
    const omitted = createWebClient(
      "A",
      rpcUrl,
      undefined,
      "createClientWithExternalKeystore"
    );
    const named = createWebClient("B", rpcUrl, `MidenClientDB_${rpcUrl}`);
    const a = await omitted.created;
    const b = await named.created;

    const sync = a.syncState();
    await waitForStart("A.syncState");
    const imported = b.importNoteFile("f1");
    await flush();
    expect(events).toEqual(["start A.syncState"]);

    await release("A.syncState");
    await release("B.importNoteFile f1");
    await Promise.all([sync, imported]);
    expect(lockRequest.mock.calls.map(([name]) => name)).toEqual([
      `miden-sync-MidenClientDB_${rpcUrl}`,
      `miden-sync-MidenClientDB_${rpcUrl}`,
    ]);
  });

  it("takes different locks for two clients whose node URLs resolve to different default stores, so neither waits", async () => {
    const a = await createWebClient("A", "http://node-a").created;
    const b = await createWebClient("B", "http://node-b").created;

    const sync = a.syncState();
    await waitForStart("A.syncState");
    const imported = b.importNoteFile("f1");
    await waitForStart("B.importNoteFile f1");

    await release("B.importNoteFile f1");
    await release("A.syncState");
    await Promise.all([sync, imported]);
    expect(lockRequest.mock.calls.map(([name]) => name)).toEqual([
      "miden-sync-MidenClientDB_http://node-a",
      "miden-sync-MidenClientDB_http://node-b",
    ]);
  });

  it.each(["createClient", "createClientWithExternalKeystore"])(
    "makes a client built by %s with a storeName take the lock of that store, the default store of another node URL",
    async (factory) => {
      const store = "MidenClientDB_http://node-a";
      const a = await createWebClient("A", "http://node-a", undefined, factory)
        .created;
      const b = await createWebClient("B", "http://node-b", store, factory)
        .created;

      const sync = a.syncState();
      await waitForStart("A.syncState");
      const imported = b.importNoteFile("f1");
      await flush();
      expect(lockRequest.mock.calls.map(([name]) => name)).toEqual([
        `miden-sync-${store}`,
        `miden-sync-${store}`,
      ]);
      expect(events).toEqual(["start A.syncState"]);

      await release("A.syncState");
      await release("B.importNoteFile f1");
      await Promise.all([sync, imported]);
      expect(events).toEqual([
        "start A.syncState",
        "end A.syncState",
        "start B.importNoteFile f1",
        "end B.importNoteFile f1",
      ]);
    }
  );

  it.each(["createClient", "createClientWithExternalKeystore"])(
    "makes a client built by %s with a custom storeName take the lock named after it",
    async (factory) => {
      const client = await createWebClient(
        "A",
        "http://node-a",
        "custom-store",
        factory
      ).created;

      const sync = client.syncState();
      await waitForStart("A.syncState");
      expect(lockRequest.mock.calls.map(([name]) => name)).toEqual([
        "miden-sync-custom-store",
      ]);
      await release("A.syncState");
      await sync;
    }
  );

  it.each(["createClient", "createClientWithExternalKeystore"])(
    "makes %s terminate the instance it built when the store name cannot be resolved",
    async (factory) => {
      const failure = new Error("Invalid node URL");
      fakeWasm.storeNameFailure = failure;
      const { created, wasmClient } = createWebClient(
        "A",
        "not a url",
        undefined,
        factory
      );

      await expect(created).rejects.toBe(failure);
      await flush();
      expect(wasmClient.free).toHaveBeenCalledTimes(1);
    }
  );

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

  // Each call is the first on its client, so nothing else on that client can
  // hold it behind the holder: only its own lock request can. The creations
  // and syncBeforeAccountCreation run on a store at genesis.
  const midenOf = (c) => new MidenClient(c.client, async () => fakeWasm, null);
  const firstCalls = [
    {
      name: "newWallet",
      call: (c) => c.client.newWallet("private", "falcon"),
      label: "newWallet private",
    },
    {
      name: "newFaucet",
      call: (c) =>
        c.client.newFaucet("private", false, "T", "TOK", 8, 1n, "falcon"),
      label: "newFaucet private",
    },
    {
      name: "newAccount",
      call: (c) => c.client.newAccount("account", false),
      label: "newAccount account",
    },
    {
      name: "newAccountWithSecretKey",
      call: (c) => c.client.newAccountWithSecretKey("keyed", "key"),
      label: "newAccountWithSecretKey keyed",
    },
    {
      name: "importNoteFile",
      call: (c) => c.client.importNoteFile("f1"),
      label: "importNoteFile f1",
    },
    {
      name: "notes.import",
      call: (c) => midenOf(c).notes.import("f1"),
      label: "importNoteFile f1",
    },
    {
      name: "fetchPrivateNotes",
      call: (c) => c.client.fetchPrivateNotes(),
      label: "fetchPrivateNotes",
    },
    {
      name: "notes.fetchPrivate",
      call: (c) => midenOf(c).notes.fetchPrivate(),
      label: "fetchPrivateNotes",
    },
    {
      name: "syncBeforeAccountCreation",
      prepare: (c) => {
        c.wasmClient.syncBeforeAccountCreation = parkedCall(
          "B",
          "syncBeforeAccountCreation"
        );
      },
      call: (c) => c.client.syncBeforeAccountCreation(),
      label: "syncBeforeAccountCreation",
    },
    {
      name: "syncState",
      call: (c) => c.client.syncState(),
      label: "syncState",
    },
    {
      name: "syncChain",
      call: (c) => c.client.syncChain(),
      label: "syncChain",
    },
    {
      name: "syncNoteTransport",
      call: (c) => c.client.syncNoteTransport(),
      label: "syncNoteTransport",
    },
    {
      name: "MockWebClient syncState",
      mock: true,
      call: (c) => c.client.syncState(),
      label: "syncState",
    },
    {
      name: "MockWebClient syncChain",
      mock: true,
      call: (c) => c.client.syncChain(),
      label: "syncChain",
    },
    {
      name: "MockWebClient syncNoteTransport",
      mock: true,
      call: (c) => c.client.syncNoteTransport(),
      label: "syncNoteTransport",
    },
  ];
  it.each(firstCalls)(
    "makes $name, the first call on its client, request the store lock and wait for another client's holder",
    async ({ mock = false, prepare, call, label }) => {
      const store = mock ? undefined : uniqueStore();
      const lockName = mock
        ? "miden-sync-mock_client_db"
        : `miden-sync-${store}`;
      const a = makeWebClient(store, "A", { mock });
      const b = makeWebClient(store, "B", { mock });
      prepare?.(b);

      const held = a.client.importNoteFile("held");
      await waitForStart("A.importNoteFile held");
      const requestsBefore = lockRequest.mock.calls.length;
      const result = call(b);
      await flush();
      expect(events).toEqual(["start A.importNoteFile held"]);
      expect(
        lockRequest.mock.calls.slice(requestsBefore).map(([name]) => name)
      ).toEqual([lockName]);

      await release("A.importNoteFile held");
      await release(`B.${label}`);
      await Promise.all([held, result]);
      expect(events).toEqual([
        "start A.importNoteFile held",
        "end A.importNoteFile held",
        `start B.${label}`,
        `end B.${label}`,
      ]);
    }
  );

  // MockWebClient's syncs are not observed.
  it.each(firstCalls.filter(({ mock }) => !mock))(
    "observes $name, the first call on its client, once, timed from when it was made, so its duration includes another client's hold of the store lock",
    async ({ prepare, call, label }) => {
      const store = uniqueStore();
      const a = makeWebClient(store, "A");
      const b = makeWebClient(store, "B");
      prepare?.(b);
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);

      const held = a.client.importNoteFile("held");
      await waitForStart("A.importNoteFile held");
      // Registered after the holder's call, so only `call` is observed.
      const seen = [];
      setObserver((observation) => seen.push(observation));
      const result = call(b);
      await flush();
      now = 1000;

      await release("A.importNoteFile held");
      await release(`B.${label}`);
      await Promise.all([held, result]);
      expect(seen).toEqual([
        { op: label.split(" ")[0], outcome: "ok", durationMs: 1000 },
      ]);
    }
  );

  const creations = [
    {
      name: "newWallet",
      call: (c) => c.client.newWallet("private", "falcon"),
      args: ["private", 2, undefined, true],
    },
    {
      name: "newFaucet",
      call: (c) =>
        c.client.newFaucet("private", false, "T", "TOK", 8, 1n, "falcon"),
      args: ["private", false, "T", "TOK", 8, 1n, 2, true],
    },
    {
      name: "newAccount",
      call: (c) => c.client.newAccount("account", false),
      args: ["account", false, true],
    },
    {
      name: "newAccountWithSecretKey",
      call: (c) => c.client.newAccountWithSecretKey("keyed", "key"),
      args: ["keyed", "key", true],
    },
  ];

  it.each(creations)(
    "runs $name as one observed call holding the store lock for its genesis sync only, then creating with its own pre-sync skipped",
    async ({ name, call, args }) => {
      const ops = [];
      setObserver((observation) => ops.push(observation.op));
      const store = uniqueStore();
      const a = makeWebClient(store, "A");
      const lock = () =>
        heldLocks.has(`miden-sync-${store}`) ? "locked" : "unlocked";
      const steps = [];
      a.wasmClient.syncBeforeAccountCreation = vi.fn(async () => {
        steps.push(`pre-sync ${lock()}`);
      });
      a.wasmClient[name] = vi.fn(async () => {
        steps.push(`${name} ${lock()}`);
        return name;
      });

      await expect(call(a)).resolves.toBe(name);
      expect(steps).toEqual(["pre-sync locked", `${name} unlocked`]);
      expect(a.wasmClient[name]).toHaveBeenCalledWith(...args);
      expect(ops).toEqual([name]);
    }
  );

  // The two calls that run account creation's genesis sync.
  const preSyncCalls = [
    {
      name: "newWallet",
      call: (c) => c.client.newWallet("private", "falcon"),
      value: "wallet",
      createCalls: [["private", 2, undefined, true]],
    },
    {
      name: "syncBeforeAccountCreation",
      call: (c) => c.client.syncBeforeAccountCreation(),
      value: undefined,
      createCalls: [],
    },
  ];

  // A client whose sync height read is `getSyncHeight`, whose newWallet
  // settles at once, and whose pre-sync records whether it ran under the lock.
  function preSyncClient(store, getSyncHeight) {
    const c = makeWebClient(store, "B");
    const steps = [];
    c.wasmClient.getSyncHeight = vi.fn(getSyncHeight);
    c.wasmClient.syncBeforeAccountCreation = vi.fn(async () => {
      const held = heldLocks.has(`miden-sync-${store}`);
      steps.push(held ? "pre-sync locked" : "pre-sync unlocked");
    });
    c.wasmClient.newWallet = vi.fn(async () => "wallet");
    return { ...c, steps };
  }

  it.each(preSyncCalls)(
    "settles $name on a store past genesis while another client holds the store lock, requesting no lock and skipping the pre-sync",
    async ({ call, value, createCalls }) => {
      const store = uniqueStore();
      const a = makeWebClient(store, "A");
      const b = preSyncClient(store, async () => 7);

      const held = a.client.importNoteFile("held");
      await waitForStart("A.importNoteFile held");
      const requestsBefore = lockRequest.mock.calls.length;
      const result = call(b);
      expect(await state(result)).toBe("resolved");
      expect(heldLocks.has(`miden-sync-${store}`)).toBe(true);
      await expect(result).resolves.toBe(value);
      expect(lockRequest.mock.calls.length).toBe(requestsBefore);
      expect(b.wasmClient.getSyncHeight).toHaveBeenCalledTimes(1);
      expect(b.wasmClient.syncBeforeAccountCreation).not.toHaveBeenCalled();
      expect(b.wasmClient.newWallet.mock.calls).toEqual(createCalls);

      await release("A.importNoteFile held");
      await held;
    }
  );

  it.each(preSyncCalls)(
    "observes $name on a store past genesis without another client's hold of the store lock in its duration",
    async ({ name, call }) => {
      const store = uniqueStore();
      const a = makeWebClient(store, "A");
      const b = preSyncClient(store, async () => 7);
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);

      const held = a.client.importNoteFile("held");
      await waitForStart("A.importNoteFile held");
      // Registered after the holder's call, so only `call` is observed.
      const seen = [];
      setObserver((observation) => seen.push(observation));
      const result = call(b);
      await flush();
      now = 1000;

      await release("A.importNoteFile held");
      await Promise.all([held, result]);
      expect(seen).toEqual([{ op: name, outcome: "ok", durationMs: 0 }]);
    }
  );

  it.each(preSyncCalls)(
    "makes $name on a store at genesis wait for another client's hold of the store lock and run the pre-sync under it",
    async ({ call, value, createCalls }) => {
      const store = uniqueStore();
      const a = makeWebClient(store, "A");
      const b = preSyncClient(store, async () => 0);

      const held = a.client.importNoteFile("held");
      await waitForStart("A.importNoteFile held");
      const requestsBefore = lockRequest.mock.calls.length;
      const result = call(b);
      expect(await state(result)).toBe("pending");
      expect(b.steps).toEqual([]);
      expect(
        lockRequest.mock.calls.slice(requestsBefore).map(([name]) => name)
      ).toEqual([`miden-sync-${store}`]);

      await release("A.importNoteFile held");
      await held;
      await expect(result).resolves.toBe(value);
      expect(b.steps).toEqual(["pre-sync locked"]);
      expect(b.wasmClient.newWallet.mock.calls).toEqual(createCalls);
    }
  );

  it.each(preSyncCalls)(
    "takes the genesis path for $name when the sync height read rejects: one lock request, the pre-sync under it, and no rejection",
    async ({ call, value, createCalls }) => {
      const store = uniqueStore();
      const b = preSyncClient(store, async () => {
        throw new Error("failed to get sync height");
      });

      await expect(call(b)).resolves.toBe(value);
      expect(lockRequest.mock.calls.map(([name]) => name)).toEqual([
        `miden-sync-${store}`,
      ]);
      expect(b.steps).toEqual(["pre-sync locked"]);
      expect(b.wasmClient.newWallet.mock.calls).toEqual(createCalls);
    }
  );

  it("refuses a non-fungible faucet with the wasm client's bare string before its genesis sync or a store-lock request", async () => {
    const message = "Non-fungible faucets are not supported yet";
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    // As the wasm newFaucet does: a bare string, not an Error.
    a.wasmClient.newFaucet = vi.fn(async (_mode, nonFungible) => {
      if (nonFungible) throw message;
      return "faucet";
    });

    await expect(
      a.client.newFaucet("private", true, "T", "TOK", 8, 1n, "falcon")
    ).rejects.toBe(message);
    expect(lockRequest).not.toHaveBeenCalled();
    expect(a.wasmClient.syncBeforeAccountCreation).not.toHaveBeenCalled();
    expect(a.wasmClient.newFaucet).not.toHaveBeenCalled();
  });

  it("finishes newWallet when the external keystore's insertKey awaits a sync on another client of the store, and both settle", async () => {
    const store = uniqueStore();
    const b = makeWebClient(store, "B");
    b.wasmClient.syncStateImpl = vi.fn(async () => "B.syncState");
    let synced;
    const insertKey = vi.fn(async () => {
      synced = b.client.syncState();
      await synced;
    });
    const wasmClient = makeWasmClient("A");
    wasmClient.createClientWithExternalKeystore = vi.fn(async () => {});
    // As the Rust keystore does once the wallet is stored.
    wasmClient.newWallet = vi.fn(async () => {
      const insertKeyCb =
        wasmClient.createClientWithExternalKeystore.mock.calls[0][6];
      await insertKeyCb("key", "account");
      return "wallet";
    });
    fakeWasm.nextClients.push(wasmClient);
    const a = await WasmWebClient.createClientWithExternalKeystore(
      undefined,
      undefined,
      undefined,
      store,
      undefined,
      insertKey,
      undefined,
      undefined,
      false
    );

    const created = a.newWallet("private", "falcon");
    const timedOut = new Promise((resolve) =>
      setTimeout(() => resolve("timed out"), 1000)
    );
    expect(await Promise.race([created, timedOut])).toBe("wallet");
    expect(insertKey).toHaveBeenCalledTimes(1);
    await expect(synced).resolves.toBe("B.syncState");
  });

  it("resolves a newWallet queued before terminate() while its genesis sync waits for the store lock", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const holder = makeWebClient(store, "H");

    const held = holder.client.importNoteFile("held");
    await waitForStart("H.importNoteFile held");
    const created = a.client.newWallet("private", "falcon");
    await flush();
    a.instance.terminate();
    await release("H.importNoteFile held");
    await held;

    expect(await state(created)).toBe("pending");
    await release("A.newWallet private");
    await expect(created).resolves.toBe("A.newWallet private");
    await a.instance.waitForIdle();
    expect(a.wasmClient.free).toHaveBeenCalledTimes(1);
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

  it("runs a live client's sync as its own run after a terminated client's queued run of the same sync, which still settles and frees its client", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const b = makeWebClient(store, "B");
    const c = makeWebClient(store, "C");

    const holder = c.client.syncChain();
    await waitForStart("C.syncChain");
    const owned = a.client.syncState();
    await flush();
    a.instance.terminate();
    const own = b.client.syncState();
    await release("C.syncChain");
    await holder;

    await release("A.syncState");
    await expect(owned).resolves.toBe("A.syncState");
    expect(await state(own)).toBe("pending");
    await release("B.syncState");
    await expect(own).resolves.toBe("B.syncState");
    expect(b.wasmClient.syncStateImpl).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "start C.syncChain",
      "end C.syncChain",
      "start A.syncState",
      "end A.syncState",
      "start B.syncState",
      "end B.syncState",
    ]);
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

    // The early check in _withStoreLock and _serializeWasmCall both reject
    // here, so this pins the drain, not either guard.
    const requests = lockRequest.mock.calls.length;
    await expect(b.client.fetchPrivateNotes()).rejects.toThrow(
      "WebClient terminated"
    );
    expect(lockRequest).toHaveBeenCalledTimes(requests);
  });

  // A withSyncLock callback that holds the store lock until `go` resolves.
  const holdStoreLock = (store, go, work) =>
    withSyncLock(store, "callback", async () => {
      events.push("start callback");
      await go;
      return work();
    });

  it("does not start a read on a client while a withSyncLock callback holds the store lock a sync queued on that client waits for", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const go = deferred();
    let read;
    const callback = holdStoreLock(store, go.promise, async () => {
      read = a.client.getAccounts();
      await Promise.race([read, flush()]);
      return [...events];
    });
    await vi.waitFor(() => expect(events).toEqual(["start callback"]));

    const sync = a.client.syncState();
    await flush();
    go.resolve();
    expect(await callback).toEqual(["start callback"]);

    await release("A.syncState");
    await expect(sync).resolves.toBe("A.syncState");
    await release("A.getAccounts");
    await expect(read).resolves.toBe("A.getAccounts");
    expect(events).toEqual([
      "start callback",
      "start A.syncState",
      "end A.syncState",
      "start A.getAccounts",
      "end A.getAccounts",
    ]);
  });

  it("does not grant a lock held across a client's queued sync to a withSyncLock callback holding the store lock that sync waits for", async () => {
    const store = uniqueStore();
    const a = makeWebClient(store, "A");
    const appLock = new AsyncLock();
    const go = deferred();
    let acquired;
    const callback = holdStoreLock(store, go.promise, async () => {
      acquired = appLock.runExclusive(async () => events.push("acquired"));
      await Promise.race([acquired, flush()]);
      return [...events];
    });
    await vi.waitFor(() => expect(events).toEqual(["start callback"]));

    const held = appLock.runExclusive(() => a.client.syncState());
    await flush();
    go.resolve();
    expect(await callback).toEqual(["start callback"]);

    await release("A.syncState");
    await expect(held).resolves.toBe("A.syncState");
    await acquired;
    expect(events).toEqual([
      "start callback",
      "start A.syncState",
      "end A.syncState",
      "acquired",
    ]);
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
