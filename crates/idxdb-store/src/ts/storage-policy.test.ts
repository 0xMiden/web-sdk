import { afterEach, describe, expect, it, vi } from "vitest";
import type { DBCore } from "dexie";
import {
  MidenDatabase,
  openDatabase,
  openDatabaseWithOptions,
  closeDatabase,
  getDatabase,
  MIGRATION_BASELINE,
  SETTING_SCOPE_USER,
} from "./schema.js";
import { uniqueDbName } from "./test-utils.js";

type Failure = {
  backend: string;
  storeName: string;
  phase: string;
  operation: string;
  kind: string;
  errorName: string;
  eventId: string;
};

type Options = {
  durability?: "default" | "strict" | "relaxed";
  onFailure?: (failure: Failure) => void;
};

// Faults enter fake-indexeddb's backend, retaining its request dispatch and rollback.
type BackendTransaction = IDBTransaction & {
  _requests: { request: IDBRequest }[];
  _state: string;
  _start(): void;
  _abort(errorName: string | null): void;
  _execRequestAsync(request: {
    source: IDBObjectStore;
    operation: () => unknown;
  }): IDBRequest;
};

const databases: MidenDatabase[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) {
    db.dexie.close();
    await db.dexie.delete();
  }
});

async function open(options: Options = {}) {
  const name = uniqueDbName();
  const db = new MidenDatabase(name, options);
  databases.push(db);
  await db.open(MIGRATION_BASELINE);
  return { db, name };
}

function interceptTransactions(
  db: MidenDatabase,
  install: (tx: BackendTransaction) => void
) {
  const core = (db.dexie as unknown as { core: DBCore }).core;
  const transaction = core.transaction;
  return vi.spyOn(core, "transaction").mockImplementation(function (
    this: DBCore,
    ...args: Parameters<DBCore["transaction"]>
  ) {
    const tx = transaction.apply(this, args) as BackendTransaction;
    install(tx);
    return tx;
  });
}

function expectFailure(
  failure: Failure,
  name: string,
  phase: string,
  kind: string,
  errorName: string
) {
  expect(failure).toEqual({
    backend: "indexeddb",
    storeName: name,
    phase,
    operation: `indexeddb.${phase}`,
    kind,
    errorName,
    eventId: expect.any(String),
  });
  expect(failure.eventId.length).toBeGreaterThan(0);
  expect(failure.eventId.length).toBeLessThanOrEqual(128);
}

describe("IndexedDB storage policy", () => {
  it("requests strict native durability for explicit and implicit auth writes", async () => {
    const { db } = await open({ durability: "strict" });
    const transactions: IDBTransaction[] = [];
    interceptTransactions(db, (tx) => transactions.push(tx));

    await db.dexie.transaction("rw", db.settings, async () => {
      await db.settings.put({
        scope: SETTING_SCOPE_USER,
        key: "strict-setting",
        value: new Uint8Array([1]),
      });
    });
    await db.accountAuths.add({
      pubKeyCommitmentHex: "test-public-key",
      secretKeyHex: "test-secret",
    });

    expect(transactions).toHaveLength(2);
    expect(transactions.map((tx) => tx.mode)).toEqual([
      "readwrite",
      "readwrite",
    ]);
    expect(transactions.map((tx) => tx.durability)).toEqual([
      "strict",
      "strict",
    ]);
  });

  it.each([
    ["read", "UnknownError", "io"],
    ["write", "QuotaExceededError", "quota"],
  ] as const)(
    "reports a native %s failure before rejection without exposing payloads",
    async (phase, errorName, kind) => {
      const failures: Failure[] = [];
      const order: string[] = [];
      const { db, name } = await open({
        onFailure: (failure) => {
          failures.push(failure);
          order.push("failure");
        },
      });
      const nativeError = new DOMException(
        "private-key-and-record-content-must-not-escape",
        errorName
      );
      let injected = false;
      interceptTransactions(db, (tx) => {
        const execute = tx._execRequestAsync;
        tx._execRequestAsync = function (request) {
          if (!injected && request.source?.name === "settings") {
            injected = true;
            return execute.call(this, {
              ...request,
              operation: () => {
                throw nativeError;
              },
            });
          }
          return execute.call(this, request);
        };
      });

      const operation =
        phase === "read"
          ? db.settings.get([SETTING_SCOPE_USER, "private-record-key"])
          : db.settings.put({
              scope: SETTING_SCOPE_USER,
              key: "private-record-key",
              value: new Uint8Array([42]),
            });
      const error = await operation.catch((reason: Error) => {
        order.push("rejection");
        return reason;
      });

      expect(injected).toBe(true);
      expect(error).toMatchObject({ name: errorName });
      expect(order).toEqual(["failure", "rejection"]);
      expect(failures).toHaveLength(1);
      expectFailure(failures[0], name, phase, kind, errorName);
      expect(JSON.stringify(failures)).not.toContain("private-");
    }
  );

  it.each([
    ["UnknownError", "io", false],
    [null, "unexpected-abort", false],
    ["UnknownError", "io", true],
  ] as const)(
    "reports late native commit failure %s once after caught validation=%s",
    async (cause, kind, caughtValidation) => {
      const failures: Failure[] = [];
      const order: string[] = [];
      const { db, name } = await open({
        onFailure: (failure) => {
          failures.push(failure);
          order.push("failure");
        },
      });
      if (caughtValidation) {
        await db.settings.add({
          scope: SETTING_SCOPE_USER,
          key: "existing",
          value: new Uint8Array([0]),
        });
      }
      let successes = 0;
      let injected = false;
      interceptTransactions(db, (tx) => {
        if (tx.mode !== "readwrite") return;
        const execute = tx._execRequestAsync;
        tx._execRequestAsync = function (request) {
          const result = execute.call(this, request);
          result.addEventListener("success", () => {
            successes += 1;
          });
          return result;
        };
        const start = tx._start;
        tx._start = function () {
          if (
            !injected &&
            successes === 2 &&
            this._requests.length === 0 &&
            this._state !== "finished"
          ) {
            injected = true;
            this._abort(cause);
            return;
          }
          start.call(this);
        };
      });

      const error = await db.dexie
        .transaction("rw", db.settings, async () => {
          if (caughtValidation) {
            await db.settings
              .add({
                scope: SETTING_SCOPE_USER,
                key: "existing",
                value: new Uint8Array([0]),
              })
              .catch("ConstraintError", () => undefined);
          }
          for (const key of ["first-write", "second-write"]) {
            await db.settings.put({
              scope: SETTING_SCOPE_USER,
              key,
              value: new Uint8Array([1]),
            });
          }
          order.push("body-complete");
        })
        .catch((reason: Error) => {
          order.push("rejection");
          return reason;
        });

      expect(injected).toBe(true);
      expect(successes).toBe(2);
      expect(error).toMatchObject({ name: "AbortError" });
      if (cause) expect(error).toMatchObject({ inner: { name: cause } });
      expect(
        await db.settings.get([SETTING_SCOPE_USER, "first-write"])
      ).toBeUndefined();
      expect(
        await db.settings.get([SETTING_SCOPE_USER, "second-write"])
      ).toBeUndefined();
      expect(order).toEqual(["body-complete", "failure", "rejection"]);
      expect(failures).toHaveLength(1);
      expectFailure(failures[0], name, "commit", kind, cause ?? "AbortError");
    }
  );
});

function failRequests(db: MidenDatabase, errorName: string) {
  return interceptTransactions(db, (tx) => {
    const execute = tx._execRequestAsync;
    tx._execRequestAsync = function (request) {
      return execute.call(this, {
        ...request,
        operation: () => {
          throw new DOMException("private backend detail", errorName);
        },
      });
    };
  });
}

const setting = {
  scope: SETTING_SCOPE_USER,
  key: "key",
  value: new Uint8Array([7]),
};

describe("IndexedDB policy exclusions and ownership", () => {
  it.each([null, [], { durability: "immediate" }, { onFailure: true }])(
    "rejects invalid options before opening: %j",
    async (options) => {
      const nativeOpen = vi.spyOn(indexedDB, "open");
      await expect(open(options as unknown as Options)).rejects.toThrow(
        TypeError
      );
      expect(nativeOpen).not.toHaveBeenCalled();
    }
  );

  it.each(["default", "relaxed"] as const)(
    "passes explicit %s durability to native writes",
    async (durability) => {
      const { db } = await open({ durability });
      const transactions: IDBTransaction[] = [];
      interceptTransactions(db, (tx) => transactions.push(tx));
      await db.settings.put(setting);
      expect(transactions.map((tx) => tx.durability)).toEqual([durability]);
    }
  );

  it("classifies a read inside a readwrite transaction as read", async () => {
    const failures: Failure[] = [];
    const { db } = await open({
      onFailure: (failure) => failures.push(failure),
    });
    failRequests(db, "UnknownError");
    await expect(
      db.dexie.transaction("rw", db.settings, () =>
        db.settings.get([SETTING_SCOPE_USER, "key"])
      )
    ).rejects.toMatchObject({ name: "UnknownError" });
    expect(failures).toHaveLength(1);
    expect(failures[0].phase).toBe("read");
  });

  it.each(["AbortError", "Error"])(
    "does not report deliberate body rollback named %s",
    async (name) => {
      const onFailure = vi.fn();
      const { db } = await open({ onFailure });
      const original = new DOMException("intentional rollback", name);
      await expect(
        db.dexie.transaction("rw", db.settings, async () => {
          await db.settings.put(setting);
          throw original;
        })
      ).rejects.toMatchObject({ name });
      expect(
        await db.settings.get([SETTING_SCOPE_USER, "key"])
      ).toBeUndefined();
      expect(onFailure).not.toHaveBeenCalled();
    }
  );

  it("does not report an actual duplicate-key validation abort", async () => {
    const onFailure = vi.fn();
    const { db } = await open({ onFailure });
    await db.settings.add(setting);
    await expect(
      db.dexie.transaction("rw", db.settings, () => db.settings.add(setting))
    ).rejects.toMatchObject({ name: "ConstraintError" });
    expect(onFailure).not.toHaveBeenCalled();
    expect((await db.settings.get([SETTING_SCOPE_USER, "key"]))?.value).toEqual(
      new Uint8Array([7])
    );
  });

  it("reports quota after a caught validation failure in the same transaction", async () => {
    const failures: Failure[] = [];
    const { db } = await open({
      onFailure: (failure) => failures.push(failure),
    });
    await db.settings.add(setting);
    let requests = 0;
    interceptTransactions(db, (tx) => {
      const execute = tx._execRequestAsync;
      tx._execRequestAsync = function (request) {
        requests++;
        return execute.call(
          this,
          requests === 2
            ? {
                ...request,
                operation: () => {
                  throw new DOMException("quota", "QuotaExceededError");
                },
              }
            : request
        );
      };
    });
    await expect(
      db.dexie.transaction("rw", db.settings, async () => {
        await db.settings
          .add(setting)
          .catch("ConstraintError", () => undefined);
        await db.settings.put({ ...setting, key: "second" });
      })
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe("quota");
  });

  it("isolates callback exceptions from the original rejection", async () => {
    const onFailure = vi.fn(() => {
      throw new Error("consumer exception");
    });
    const { db } = await open({ onFailure });
    failRequests(db, "QuotaExceededError");
    await expect(db.settings.put(setting)).rejects.toMatchObject({
      name: "QuotaExceededError",
    });
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("inherits pending strict policy and refuses explicit conflicts without losing holders", async () => {
    const name = uniqueDbName();
    const first = openDatabaseWithOptions(name, MIGRATION_BASELINE, {
      durability: "strict",
    });
    const second = openDatabaseWithOptions(name, MIGRATION_BASELINE);
    await expect(
      openDatabaseWithOptions(name, MIGRATION_BASELINE, {
        durability: "relaxed",
      })
    ).rejects.toThrow(/Conflicting/);
    const [firstToken, secondToken] = await Promise.all([first, second]);
    const db = getDatabase(name);
    databases.push(db);
    const transactions: IDBTransaction[] = [];
    interceptTransactions(db, (tx) => transactions.push(tx));
    closeDatabase(name, firstToken);
    await db.settings.put(setting);
    expect(transactions[0].durability).toBe("strict");
    await expect(
      openDatabaseWithOptions(name, MIGRATION_BASELINE, {
        durability: "default",
      })
    ).rejects.toThrow(/Conflicting/);
    closeDatabase(name, secondToken);
    expect(() => getDatabase(name)).toThrow(/Database not found/);
  });

  it("releases identical callbacks independently and keeps legacy close anonymous", async () => {
    const callback = vi.fn();
    const name = uniqueDbName();
    const first = await openDatabaseWithOptions(name, MIGRATION_BASELINE, {
      onFailure: callback,
    });
    const second = await openDatabaseWithOptions(name, MIGRATION_BASELINE, {
      onFailure: callback,
    });
    expect(await openDatabase(name, MIGRATION_BASELINE)).toBe(name);
    const db = getDatabase(name);
    databases.push(db);
    failRequests(db, "UnknownError");
    await expect(
      db.settings.get([SETTING_SCOPE_USER, "key"])
    ).rejects.toThrow();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[0][0].eventId).toBe(
      callback.mock.calls[1][0].eventId
    );
    callback.mockClear();
    closeDatabase(name);
    closeDatabase(name, first);
    closeDatabase(name, first);
    await expect(
      db.settings.get([SETTING_SCOPE_USER, "key"])
    ).rejects.toThrow();
    expect(callback).toHaveBeenCalledTimes(1);
    closeDatabase(name, second);
    expect(db.dexie.isOpen()).toBe(false);
  });

  it("routes failures to only the affected store", async () => {
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const first = await open({ onFailure: firstCallback });
    const second = await open({ onFailure: secondCallback });
    failRequests(first.db, "UnknownError");
    await expect(
      first.db.settings.get([SETTING_SCOPE_USER, "key"])
    ).rejects.toThrow();
    await second.db.settings.put(setting);
    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(firstCallback.mock.calls[0][0].storeName).toBe(first.name);
    expect(secondCallback).not.toHaveBeenCalled();
  });

  it.each(["SecurityError", "constructor", "toString", "__proto__"])(
    "bounds native open error %s and removes failed subscriptions",
    async (errorName) => {
      const callback = vi.fn();
      const name = uniqueDbName();
      const nativeOpen = vi
        .spyOn(indexedDB, "open")
        .mockImplementationOnce(() => {
          throw new DOMException("private open detail", errorName);
        });
      await expect(
        openDatabaseWithOptions(name, MIGRATION_BASELINE, {
          onFailure: callback,
        })
      ).rejects.toThrow();
      nativeOpen.mockRestore();
      expect(callback).toHaveBeenCalledTimes(
        errorName === "SecurityError" ? 1 : 0
      );
      if (errorName === "SecurityError")
        expectFailure(
          callback.mock.calls[0][0],
          name,
          "open",
          "unavailable",
          "SecurityError"
        );
      callback.mockClear();
      const token = await openDatabaseWithOptions(name, MIGRATION_BASELINE);
      const db = getDatabase(name);
      databases.push(db);
      failRequests(db, "UnknownError");
      await expect(db.settings.put(setting)).rejects.toThrow();
      expect(callback).not.toHaveBeenCalled();
      closeDatabase(name, token);
    }
  );
});

it("suppresses native request AbortError fallout when the body aborts with writes outstanding", async () => {
  const onFailure = vi.fn();
  const { db } = await open({ onFailure });
  let issued = 0;
  interceptTransactions(db, (tx) => {
    const execute = tx._execRequestAsync;
    tx._execRequestAsync = function (request) {
      issued++;
      return execute.call(this, request);
    };
  });
  let pending: PromiseLike<unknown> | undefined;
  const original = new Error("deliberate validation rollback");
  await expect(
    db.dexie.transaction("rw", db.settings, () => {
      pending = db.settings.put(setting).catch((error) => error);
      throw original;
    })
  ).rejects.toBe(original);
  const cancelled = await pending;
  expect(issued).toBeGreaterThan(0);
  expect(cancelled).toMatchObject({ name: "AbortError" });
  expect(onFailure).not.toHaveBeenCalled();
  expect(await db.settings.get([SETTING_SCOPE_USER, "key"])).toBeUndefined();
});

it("reports post-open metadata quota failure once as write even when the callback throws", async () => {
  const failures: Failure[] = [];
  const transaction = IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    const tx = transaction.apply(this, args) as BackendTransaction;
    const execute = tx._execRequestAsync;
    tx._execRequestAsync = function (request) {
      return execute.call(
        this,
        tx.mode === "readwrite" && request.source?.name === "settings"
          ? {
              ...request,
              operation: () => {
                throw new DOMException("metadata quota", "QuotaExceededError");
              },
            }
          : request
      );
    };
    return tx;
  });
  await expect(
    open({
      onFailure: (failure) => {
        failures.push(failure);
        throw new Error("consumer exception");
      },
    })
  ).rejects.toMatchObject({ name: "QuotaExceededError" });
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({
    phase: "write",
    kind: "quota",
    errorName: "QuotaExceededError",
  });
});

it.each(["read", "write"] as const)(
  "reports native transaction creation failure as %s before rejection",
  async (phase) => {
    const failures: Failure[] = [];
    const order: string[] = [];
    const nativeError = new DOMException(
      "private factory detail",
      "UnknownError"
    );
    const transaction = IDBDatabase.prototype.transaction;
    let armed = false;
    let injectedMode: IDBTransactionMode | undefined;
    // Dexie captures this factory while opening, before the fault is armed.
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      if (armed) {
        armed = false;
        injectedMode = args[1];
        throw nativeError;
      }
      return transaction.apply(this, args);
    });
    const { db, name } = await open({
      onFailure: (failure) => {
        failures.push(failure);
        order.push("failure");
      },
    });
    armed = true;
    const operation =
      phase === "read"
        ? db.settings.get([SETTING_SCOPE_USER, "key"])
        : db.settings.put(setting);
    const error = await operation.catch(
      (reason: Error & { inner?: unknown }) => {
        order.push("rejection");
        return reason;
      }
    );
    expect(injectedMode).toBe(phase === "read" ? "readonly" : "readwrite");
    expect(error).toMatchObject({ name: "UnknownError" });
    expect((error as Error & { inner?: unknown }).inner ?? error).toBe(
      nativeError
    );
    expect(order).toEqual(["failure", "rejection"]);
    expect(failures).toHaveLength(1);
    expectFailure(failures[0], name, phase, "io", "UnknownError");
  }
);

it.each(["QuotaExceededError", "ConstraintError"] as const)(
  "classifies wrapped native open cause %s without relabeling validation as unexpected abort",
  async (errorName) => {
    const failures: Failure[] = [];
    const order: string[] = [];
    const cause = new DOMException("private inner detail", errorName);
    const wrapped = Object.assign(
      new DOMException("private wrapper", "AbortError"),
      { inner: cause }
    );
    const nativeOpen = vi
      .spyOn(indexedDB, "open")
      .mockImplementationOnce(() => {
        throw wrapped;
      });
    const name = uniqueDbName();
    const db = new MidenDatabase(name, {
      onFailure: (failure) => {
        failures.push(failure);
        order.push("failure");
      },
    });
    databases.push(db);
    const error = await db.open(MIGRATION_BASELINE).catch((reason: unknown) => {
      order.push("rejection");
      return reason;
    });
    expect(nativeOpen).toHaveBeenCalledTimes(1);
    expect(error).toBe(wrapped);
    expect(wrapped.inner).toBe(cause);
    if (errorName === "QuotaExceededError") {
      expect(order).toEqual(["failure", "rejection"]);
      expect(failures).toHaveLength(1);
      expectFailure(failures[0], name, "open", "quota", "QuotaExceededError");
    } else {
      expect(order).toEqual(["rejection"]);
      expect(failures).toEqual([]);
    }
  }
);
