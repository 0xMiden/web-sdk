// Shared test utilities for vitest + fake-indexeddb tests.

let dbCounter = 0;

/** Returns a unique database name to avoid collisions between tests. */
export function uniqueDbName(): string {
  return `test-miden-${++dbCounter}-${Date.now()}`;
}

export interface RecordedRead {
  store: string;
  /** The index the read went through, or null for a read of the store itself. */
  index: string | null;
  /** False when no key range was passed, so the read covers every row. */
  ranged: boolean;
}

const READ_METHODS = [
  "openCursor",
  "openKeyCursor",
  "getAll",
  "getAllKeys",
  "count",
] as const;

// Dexie passes the range inside an options object ({ query, direction }) and spells "every row"
// as a null query or lowerBound(-Infinity).
function isBoundedQuery(query: unknown): boolean {
  const range =
    query !== null && typeof query === "object" && "query" in query
      ? (query as { query: unknown }).query
      : query;
  if (range === undefined || range === null) return false;
  const { lower, upper } = range as Partial<IDBKeyRange>;
  return !(lower === -Infinity && upper === undefined);
}

/**
 * Records every multi-row read on IDBObjectStore and IDBIndex with the index it used and whether
 * it carried a key range. A hot path that scans a whole table shows up as an unranged read.
 * Call `stop()` to restore the originals.
 */
export function recordReads(): { reads: RecordedRead[]; stop: () => void } {
  const reads: RecordedRead[] = [];
  const restores: Array<() => void> = [];
  const targets: Array<[any, boolean]> = [
    [IDBObjectStore.prototype, false],
    [IDBIndex.prototype, true],
  ];
  for (const [proto, isIndex] of targets) {
    for (const method of READ_METHODS) {
      const original = proto[method];
      proto[method] = function (
        this: any,
        query?: unknown,
        ...rest: unknown[]
      ) {
        reads.push({
          store: isIndex ? this.objectStore.name : this.name,
          index: isIndex ? this.name : null,
          ranged: isBoundedQuery(query),
        });
        return original.call(this, query, ...rest);
      };
      restores.push(() => {
        proto[method] = original;
      });
    }
  }
  return { reads, stop: () => restores.forEach((restore) => restore()) };
}
