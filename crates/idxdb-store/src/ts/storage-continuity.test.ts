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
): Promise<number | undefined> {
  const open = Reflect.get(schema, "openDatabaseWithOptions");
  if (typeof open === "function") return await open(name, VERSION, options);
  await schema.openDatabase(name, VERSION);
  return undefined;
}

it("requests strict durability at the IndexedDB write transaction", async () => {
  const store = storeName();
  const token = await openWithOptions(store, { durability: "strict" });
  try {
    const connection = schema.getDatabase(store).dexie.backendDB();
    const transaction = vi.spyOn(connection, "transaction");
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
  const onFailure = vi.fn();
  const token = await openWithOptions(store, { onFailure });
  try {
    const db = schema.getDatabase(store);
    const connection = db.dexie.backendDB();
    vi.spyOn(connection, "transaction").mockImplementationOnce(() => {
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
  const released = vi.fn();
  const live = vi.fn();
  const first = await openWithOptions(store, { onFailure: released });
  const second = await openWithOptions(store, { onFailure: live });
  Reflect.apply(schema.closeDatabase, null, [store, first]);
  try {
    const db = schema.getDatabase(store);
    vi.spyOn(db.dexie.backendDB(), "transaction").mockImplementationOnce(() => {
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
