(async () => {
  const forestTables = [
    "forestTrees",
    "forestEntries",
    "forestSubtrees",
    "forestRevision",
  ];
  const accountTables = [
    "accountCode",
    "latestAccountStorage",
    "historicalAccountStorage",
    "latestStorageMapEntries",
    "historicalStorageMapEntries",
    "latestAccountAssets",
    "historicalAccountAssets",
    "latestAccountHeaders",
    "historicalAccountHeaders",
    "addresses",
    "accountAuth",
    "accountKeyMapping",
  ];
  const measuredTables = [...forestTables, ...accountTables];

  function utf8ByteLength(value) {
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 0x80) {
        bytes += 1;
      } else if (code < 0x800) {
        bytes += 2;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function approximateSerializedBytes(value, ancestors = new Set()) {
    if (value === null) {
      return 4;
    }
    if (value === undefined) {
      return 0;
    }
    if (typeof value === "string") {
      return utf8ByteLength(value) + 2;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      return 8;
    }
    if (typeof value === "boolean") {
      return 1;
    }
    if (value instanceof ArrayBuffer) {
      return value.byteLength;
    }
    if (ArrayBuffer.isView(value)) {
      return value.byteLength;
    }
    if (value instanceof Date) {
      return 8;
    }
    if (typeof value !== "object") {
      return 0;
    }
    if (ancestors.has(value)) {
      return 0;
    }

    ancestors.add(value);
    let bytes = 2;
    if (Array.isArray(value)) {
      for (const item of value) {
        bytes += approximateSerializedBytes(item, ancestors) + 1;
      }
    } else {
      for (const [key, item] of Object.entries(value)) {
        bytes +=
          utf8ByteLength(key) +
          3 +
          approximateSerializedBytes(item, ancestors) +
          1;
      }
    }
    ancestors.delete(value);
    return bytes;
  }

  function openExistingDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onupgradeneeded = () => {
        request.transaction.abort();
        reject(new Error(`IndexedDB database "${name}" does not exist`));
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  function measureStore(database, tableName) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(tableName, "readonly");
      const request = transaction.objectStore(tableName).openCursor();
      let rowCount = 0;
      let approximateBytes = 0;

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) {
          return;
        }
        rowCount += 1;
        approximateBytes += approximateSerializedBytes(cursor.value);
        cursor.continue();
      };
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () =>
        resolve({ tableName, rowCount, approximateBytes });
    });
  }

  function formatBytes(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }

  async function measureDatabase(databaseName) {
    const database = await openExistingDatabase(databaseName);
    try {
      const availableTables = measuredTables.filter((tableName) =>
        database.objectStoreNames.contains(tableName)
      );
      const rows = [];
      for (const tableName of availableTables) {
        rows.push(await measureStore(database, tableName));
      }

      const forestSet = new Set(forestTables);
      const forestBytes = rows
        .filter((row) => forestSet.has(row.tableName))
        .reduce((sum, row) => sum + row.approximateBytes, 0);
      const accountBytes = rows
        .filter((row) => !forestSet.has(row.tableName))
        .reduce((sum, row) => sum + row.approximateBytes, 0);

      console.log(`IndexedDB disk breakdown for "${databaseName}"`);
      console.table(
        rows.map((row) => ({
          table: row.tableName,
          rows: row.rowCount,
          approximateBytes: row.approximateBytes,
          approximateMiB: formatBytes(row.approximateBytes),
        }))
      );
      console.table([
        {
          group: "forest",
          approximateBytes: forestBytes,
          approximateMiB: formatBytes(forestBytes),
        },
        {
          group: "accounts",
          approximateBytes: accountBytes,
          approximateMiB: formatBytes(accountBytes),
        },
        {
          group: "total",
          approximateBytes: forestBytes + accountBytes,
          approximateMiB: formatBytes(forestBytes + accountBytes),
        },
      ]);
      console.log(
        "Sizes approximate record payloads only. IndexedDB indexes and browser storage overhead are not included."
      );
      return rows;
    } finally {
      database.close();
    }
  }

  globalThis.measureMidenIndexedDb = measureDatabase;

  const requestedName = globalThis.MIDEN_BENCH_DB_NAME;
  let databaseNames;
  if (requestedName !== undefined) {
    databaseNames = [requestedName];
  } else {
    if (typeof indexedDB.databases !== "function") {
      throw new Error(
        "Set globalThis.MIDEN_BENCH_DB_NAME before running this script because indexedDB.databases() is unavailable."
      );
    }
    const databases = await indexedDB.databases();
    databaseNames = databases
      .map(({ name }) => name)
      .filter((name) => name !== undefined);
  }

  let measured = 0;
  for (const databaseName of databaseNames) {
    const database = await openExistingDatabase(databaseName);
    const hasForestTables = forestTables.every((tableName) =>
      database.objectStoreNames.contains(tableName)
    );
    database.close();
    if (hasForestTables) {
      await measureDatabase(databaseName);
      measured += 1;
    }
  }
  if (measured === 0) {
    throw new Error(
      "No IndexedDB database containing all forest tables was found. Set globalThis.MIDEN_BENCH_DB_NAME and run the script again."
    );
  }
})().catch((error) => console.error(error));
