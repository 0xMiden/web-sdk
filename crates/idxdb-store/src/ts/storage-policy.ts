import type Dexie from "dexie";
import type { DBCoreTransaction } from "dexie";

export interface IndexedDbFailure {
  backend: "indexeddb";
  storeName: string;
  phase: "open" | "read" | "write" | "commit";
  operation:
    | "indexeddb.open"
    | "indexeddb.read"
    | "indexeddb.write"
    | "indexeddb.commit";
  kind: "quota" | "io" | "unavailable" | "unexpected-abort";
  errorName:
    | "QuotaExceededError"
    | "UnknownError"
    | "SecurityError"
    | "InvalidStateError"
    | "MissingAPIError"
    | "AbortError";
  eventId: string;
}

export interface IndexedDbOptions {
  durability?: "default" | "strict" | "relaxed";
  onFailure?: (failure: IndexedDbFailure) => void;
}

export function validateIndexedDbOptions(
  options?: IndexedDbOptions
): IndexedDbOptions {
  if (options === undefined) return {};
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("indexedDb must be an options object");
  }
  const { durability, onFailure } = options;
  if (
    durability !== undefined &&
    !["default", "strict", "relaxed"].includes(durability)
  ) {
    throw new TypeError("Invalid IndexedDB durability");
  }
  if (onFailure !== undefined && typeof onFailure !== "function") {
    throw new TypeError("IndexedDB onFailure must be a function");
  }
  return { durability, onFailure };
}

const kinds: Record<string, IndexedDbFailure["kind"]> = {
  QuotaExceededError: "quota",
  UnknownError: "io",
  SecurityError: "unavailable",
  InvalidStateError: "unavailable",
  MissingAPIError: "unavailable",
  AbortError: "unexpected-abort",
};
let scopeCounter = 0;

export class StoragePolicy {
  readonly durability: IndexedDbOptions["durability"];
  private callbacks = new Map<
    string,
    NonNullable<IndexedDbOptions["onFailure"]>
  >();
  private readonly scope = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${++scopeCounter}`;
  private sequence = 0;

  constructor(
    private readonly storeName: string,
    options?: IndexedDbOptions
  ) {
    const validated = validateIndexedDbOptions(options);
    this.durability = validated.durability;
    this.subscribe("direct", validated.onFailure);
  }

  check(options: IndexedDbOptions): void {
    if (
      options.durability !== undefined &&
      options.durability !== (this.durability ?? "default")
    ) {
      throw new TypeError("Conflicting IndexedDB durability for shared store");
    }
  }

  subscribe(token: string, callback?: IndexedDbOptions["onFailure"]): void {
    if (callback) this.callbacks.set(token, callback);
  }

  release(token: string): void {
    this.callbacks.delete(token);
  }

  report(error: unknown, phase: IndexedDbFailure["phase"]): boolean {
    let cause = error as { name?: string; inner?: unknown } | undefined;
    for (let depth = 0; cause && depth < 4; depth++) {
      if (cause.name === "AbortError" && cause.inner) {
        cause = cause.inner as typeof cause;
        continue;
      }
      const kind =
        cause.name && Object.hasOwn(kinds, cause.name) && kinds[cause.name];
      if (kind) {
        const failure: IndexedDbFailure = {
          backend: "indexeddb",
          storeName: this.storeName,
          phase,
          operation: `indexeddb.${phase}`,
          kind,
          errorName: cause.name as IndexedDbFailure["errorName"],
          eventId: `${this.scope}:${++this.sequence}`,
        };
        for (const callback of [...this.callbacks.values()]) {
          try {
            callback(Object.freeze({ ...failure }));
          } catch {
            /* Consumer errors cannot replace storage errors. */
          }
        }
        return true;
      }
      cause = cause.inner as typeof cause;
    }
    return false;
  }

  install(db: Dexie): void {
    const states = new WeakMap<
      DBCoreTransaction,
      { error?: unknown; reported: boolean; intentional: boolean }
    >();
    const notify = (
      tx: DBCoreTransaction,
      error: unknown,
      phase: "read" | "write"
    ) => {
      const state = states.get(tx);
      if (state?.reported) return;
      const native = state?.error as { name?: string } | undefined;
      if (
        state?.intentional &&
        (error as { name?: string })?.name === "AbortError" &&
        native?.name !== "AbortError"
      )
        return;
      const reported = this.report(
        native?.name === (error as { name?: string })?.name ? native : error,
        phase
      );
      if (state && reported) state.reported = true;
    };
    db.use({
      stack: "dbcore",
      name: "miden-storage-policy",
      create: (core) => ({
        ...core,
        table: (name) => {
          const table = core.table(name);
          const read = <T>(
            tx: DBCoreTransaction,
            promise: Promise<T>
          ): Promise<T> =>
            promise.catch((error: unknown) => {
              notify(tx, error, "read");
              throw error;
            });
          return {
            ...table,
            get: (req) => read(req.trans, table.get(req)),
            getMany: (req) => read(req.trans, table.getMany(req)),
            query: (req) => read(req.trans, table.query(req)),
            count: (req) => read(req.trans, table.count(req)),
            openCursor: (req) =>
              read(req.trans, table.openCursor(req)).then((cursor) => {
                if (cursor) {
                  const start = cursor.start;
                  cursor.start = function (callback) {
                    return read(req.trans, start.call(this, callback));
                  };
                }
                return cursor;
              }),
            mutate: (req) =>
              table.mutate(req).then(
                (result) => {
                  if (result.numFailures) {
                    for (const error of Object.values(result.failures))
                      notify(req.trans, error, "write");
                  }
                  return result;
                },
                (error: unknown) => {
                  notify(req.trans, error, "write");
                  throw error;
                }
              ),
          };
        },
        transaction: (stores, mode, options) => {
          let tx: IDBTransaction;
          try {
            tx = core.transaction(stores, mode, options) as IDBTransaction;
          } catch (error) {
            this.report(error, mode === "readonly" ? "read" : "write");
            throw error;
          }
          const state = {
            error: undefined as unknown,
            reported: false,
            intentional: false,
          };
          states.set(tx, state);
          const abort = tx.abort;
          tx.abort = function () {
            state.intentional = true;
            return abort.call(this);
          };
          // Capture before Dexie handles the request error and deliberately rolls back.
          tx.addEventListener(
            "error",
            (event) => {
              if (state.reported || state.intentional) return;
              state.error =
                (event.target as IDBRequest | null)?.error ?? tx.error;
            },
            true
          );
          tx.addEventListener("abort", () => {
            if (!state.reported && !state.intentional) {
              this.report(tx.error ?? { name: "AbortError" }, "commit");
            }
          });
          return tx;
        },
      }),
    });
  }
}
