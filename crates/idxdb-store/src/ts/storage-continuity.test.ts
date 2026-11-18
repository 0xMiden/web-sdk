import { afterEach, expect, it, vi } from "vitest";
import Dexie from "dexie";
import * as schema from "./schema.js";
import { uniqueDbName } from "./test-utils.js";

const VERSION = "0.18.0";
const stores: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) {
    await Dexie.delete(store);
  }
});

function storeName(): string {
  const name = uniqueDbName();
  stores.push(name);
  return name;
}

// Load the optional entry point without turning its absence into an import failure.
async function openWithOptions(
  name: string,
  options: {
    durability?: IDBTransactionDurability;
    onFailure?: (failure: unknown) => void;
  }
): Promise<string | undefined> {
  const open = Reflect.get(schema, "openDatabaseWithOptions");
  if (typeof open === "function") return await open(name, VERSION, options);
  await schema.openDatabase(name, VERSION);
  return undefined;
}

it("requests strict durability at the IndexedDB write transaction", async () => {
  const store = storeName();
  const transaction = vi.spyOn(IDBDatabase.prototype, "transaction");
  const token = await openWithOptions(store, { durability: "strict" });
  try {
    transaction.mockClear();
    await schema.getDatabase(store).settings.put({
      scope: schema.SETTING_SCOPE_USER,
      key: "probe",
      value: new Uint8Array([1]),
    });
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Array),
      "readwrite",
      expect.objectContaining({ durability: "strict" })
    );
  } finally {
    Reflect.apply(schema.closeDatabase, null, [store, token]);
  }
});

it("reports a storage-originated disk I/O failure without its private message", async () => {
  const store = storeName();
  const transaction = vi.spyOn(IDBDatabase.prototype, "transaction");
  const onFailure = vi.fn();
  const token = await openWithOptions(store, { onFailure });
  try {
    const db = schema.getDatabase(store);
    transaction.mockImplementationOnce(() => {
      throw new DOMException("private browser error", "UnknownError");
    });
    await expect(db.settings.toArray()).rejects.toThrow();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({
      phase: "read",
      kind: "io",
      errorName: "UnknownError",
    });
  } finally {
    Reflect.apply(schema.closeDatabase, null, [store, token]);
  }
});

it("stops dispatching IndexedDB failures to a released client", async () => {
  const store = storeName();
  const transaction = vi.spyOn(IDBDatabase.prototype, "transaction");
  const released = vi.fn();
  const live = vi.fn();
  const first = await openWithOptions(store, { onFailure: released });
  const second = await openWithOptions(store, { onFailure: live });
  Reflect.apply(schema.closeDatabase, null, [store, first]);
  try {
    const db = schema.getDatabase(store);
    transaction.mockImplementationOnce(() => {
      throw new DOMException("private browser error", "QuotaExceededError");
    });
    await expect(db.settings.toArray()).rejects.toThrow();
    expect(released).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledExactlyOnceWith({
      phase: "read",
      kind: "quota",
      errorName: "QuotaExceededError",
    });
  } finally {
    Reflect.apply(schema.closeDatabase, null, [store, second]);
  }
});

it("reports a browser write abort as a commit failure and ignores an ordinary abort", async () => {
  const store = storeName();
  const original = IDBDatabase.prototype.transaction;
  const transaction = vi.spyOn(IDBDatabase.prototype, "transaction");
  const onFailure = vi.fn();
  const token = await openWithOptions(store, { onFailure });
  try {
    const { settings } = schema.getDatabase(store);
    const save = () =>
      settings.put({
        scope: schema.SETTING_SCOPE_USER,
        key: "write",
        value: new Uint8Array([1]),
      });
    for (const name of ["AbortError", "UnknownError"]) {
      transaction.mockImplementationOnce(function (this: IDBDatabase, ...args) {
        const write = original.apply(this, args);
        queueMicrotask(() => {
          write.abort();
          Object.defineProperty(write, "error", {
            value: new DOMException("browser write error", name),
          });
        });
        return write;
      });
      await expect(save()).rejects.toThrow();
    }
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({
      phase: "commit",
      kind: "io",
      errorName: "UnknownError",
    });
    expect(
      await settings.get([schema.SETTING_SCOPE_USER, "write"])
    ).toBeUndefined();
  } finally {
    Reflect.apply(schema.closeDatabase, null, [store, token]);
  }
});

it("reports a backing store open I/O failure even when the observer throws", async () => {
  const store = storeName();
  const open = vi.spyOn(Dexie.dependencies.indexedDB, "open");
  const onFailure = vi.fn(() => {
    throw new Error("observer failed");
  });
  open.mockImplementation(() => {
    throw new DOMException("browser open error", "UnknownError");
  });
  await expect(openWithOptions(store, { onFailure })).rejects.toThrow();
  expect(onFailure).toHaveBeenCalledExactlyOnceWith({
    phase: "open",
    kind: "io",
    errorName: "UnknownError",
  });
});

it("reports native request errors that Dexie handles at the request", async () => {
  const store = storeName();
  const onFailure = vi.fn();
  const token = await openWithOptions(store, { onFailure });
  try {
    const { settings } = schema.getDatabase(store);
    const entry = {
      scope: schema.SETTING_SCOPE_USER,
      key: "duplicate",
      value: new Uint8Array([1]),
    };
    await settings.add(entry);
    const add = IDBObjectStore.prototype.add;
    const descriptor = Object.getOwnPropertyDescriptor(
      IDBRequest.prototype,
      "error"
    )!;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementationOnce(function (
      this: IDBObjectStore,
      ...args
    ) {
      const request = add.apply(this, args);
      Object.defineProperty(request, "error", {
        get: descriptor.get,
        set(error) {
          descriptor.set!.call(
            this,
            error?.name === "ConstraintError"
              ? new DOMException("browser request error", "UnknownError")
              : error
          );
        },
      });
      return request;
    });
    await expect(settings.add(entry)).rejects.toThrow();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({
      phase: "write",
      kind: "io",
      errorName: "UnknownError",
    });
  } finally {
    Reflect.apply(schema.closeDatabase, null, [store, token]);
  }
});
