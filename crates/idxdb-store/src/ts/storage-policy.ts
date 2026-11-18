import type Dexie from "dexie";

type FailurePhase = "open" | "read" | "write" | "commit";
type FailureKind = "quota" | "io" | "unavailable";

export interface IndexedDbFailure {
  phase: FailurePhase;
  kind: FailureKind;
  errorName: string;
}

export interface IndexedDbOptions {
  durability?: IDBTransactionDurability;
  onFailure?: (failure: IndexedDbFailure) => void;
}

const kindByName = new Map<string, FailureKind>([
  ["QuotaExceededError", "quota"],
  ["UnknownError", "io"],
  ["SecurityError", "unavailable"],
  ["InvalidStateError", "unavailable"],
  ["MissingAPIError", "unavailable"],
]);

function storageFailure(
  phase: FailurePhase,
  error: unknown
): IndexedDbFailure | undefined {
  const seen = new WeakSet();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") {
      const kind = kindByName.get(name);
      if (kind) return { phase, kind, errorName: name };
    }
    error = (error as { inner?: unknown }).inner;
  }
  return undefined;
}

function notify(
  policies: Iterable<IndexedDbOptions> | undefined,
  failure: IndexedDbFailure
): void {
  if (!policies) return;
  for (const { onFailure } of policies) {
    try {
      void Promise.resolve(onFailure?.({ ...failure })).catch(() => {});
    } catch {
      // A notification cannot replace the original IndexedDB error.
    }
  }
}

export function reportOpenFailure(
  policies: Iterable<IndexedDbOptions> | undefined,
  error: unknown
): void {
  const failure = storageFailure("open", error);
  if (failure) notify(policies, failure);
}

export function installStoragePolicy(
  db: Dexie,
  policies: () => Map<string, IndexedDbOptions> | undefined
): void {
  db.use({
    stack: "dbcore",
    name: "miden-storage-policy",
    create: (downlevel) => ({
      ...downlevel,
      transaction(stores, mode, options) {
        const active = policies();
        if (!active?.size) return downlevel.transaction(stores, mode, options);

        const durabilities = Array.from(
          active.values(),
          ({ durability }) => durability
        );
        const durability = (["strict", "default", "relaxed"] as const).find(
          (value) => durabilities.includes(value)
        );
        const requestPhase = mode === "readonly" ? "read" : "write";
        let transaction: IDBTransaction;
        try {
          transaction = downlevel.transaction(
            stores,
            mode,
            durability && mode === "readwrite"
              ? { ...options, durability }
              : options
          ) as IDBTransaction;
        } catch (error) {
          const failure = storageFailure(requestPhase, error);
          if (failure) notify(policies()?.values(), failure);
          throw error;
        }

        let reported = false;
        const report = (phase: FailurePhase, error: unknown) => {
          if (reported) return;
          const failure = storageFailure(phase, error);
          if (!failure) return;
          reported = true;
          notify(policies()?.values(), failure);
        };
        // Dexie stops request errors at their target.
        transaction.addEventListener(
          "error",
          (event) =>
            report(requestPhase, (event.target as IDBRequest | null)?.error),
          { capture: true }
        );
        transaction.addEventListener("abort", () =>
          report(requestPhase === "read" ? "read" : "commit", transaction.error)
        );
        return transaction;
      },
    }),
  });
}
