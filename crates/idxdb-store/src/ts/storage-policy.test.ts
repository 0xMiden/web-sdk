import { afterEach, describe, expect, it, vi } from "vitest";
import type { DBCore } from "dexie";
import {
  MidenDatabase,
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
  _abort(errorName: string): void;
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
  // @ts-expect-error Regression: the existing constructor ignores storage options.
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

  it("reports a late native commit failure once and rolls back successful writes", async () => {
    const failures: Failure[] = [];
    const order: string[] = [];
    const { db, name } = await open({
      onFailure: (failure) => {
        failures.push(failure);
        order.push("failure");
      },
    });
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
          this._abort("UnknownError");
          return;
        }
        start.call(this);
      };
    });

    const error = await db.dexie
      .transaction("rw", db.settings, async () => {
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
    expect(error).toMatchObject({
      name: "AbortError",
      inner: { name: "UnknownError" },
    });
    expect(
      await db.settings.get([SETTING_SCOPE_USER, "first-write"])
    ).toBeUndefined();
    expect(
      await db.settings.get([SETTING_SCOPE_USER, "second-write"])
    ).toBeUndefined();
    expect(order).toEqual(["body-complete", "failure", "rejection"]);
    expect(failures).toHaveLength(1);
    expectFailure(failures[0], name, "commit", "io", "UnknownError");
  });
});
