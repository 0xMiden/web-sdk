/**
 * Node.js-specific client factories that match the browser SDK's interface.
 *
 * The browser SDK creates clients with IndexedDB store names.
 * Node.js uses SQLite file paths and filesystem keystores.
 * These factories bridge the difference so MidenClient.create() works on both.
 */
import path from "path";
import fs from "fs";
import os from "os";
import { wrapClient, normalizeArg } from "./napi-compat.js";
import {
  claimStore,
  validateNoteTransportRetryOptions,
  validateStoreBackend,
} from "../utils.js";

let _counter = 0;

function createTempDir(label) {
  const dir = path.join(
    os.tmpdir(),
    `miden-${label}-${process.pid}-${Date.now()}-${++_counter}`
  );
  fs.mkdirSync(path.join(dir, "keystore"), { recursive: true });
  return dir;
}

// One identity per SQLite file, so every spelling of its path claims the same
// store. A parent that does not exist yet keeps its resolved spelling.
function canonicalPath(file) {
  // `..` after a symlink means the link target's parent: only a relative path
  // is made absolute first, and the native realpath, unlike the JS one, does
  // not collapse `..` lexically.
  const absolute = path.isAbsolute(file) ? file : path.resolve(file);
  for (const [dir, name] of [
    [absolute, ""],
    [path.dirname(absolute), path.basename(absolute)],
  ]) {
    try {
      return path.join(fs.realpathSync.native(dir), name);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return path.resolve(absolute);
}

/**
 * Returns a deterministic data directory for a given store name.
 * Uses ~/.miden/stores/<storeName>/ so data persists across runs.
 */
function defaultDataDir(storeName) {
  const dir = path.join(os.homedir(), ".miden", "stores", storeName);
  fs.mkdirSync(path.join(dir, "keystore"), { recursive: true });
  return dir;
}

function normBytes(val) {
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) return Array.from(val);
  return val;
}

/**
 * Checks the `storeBackend` option on Node.js, where the store is always
 * SQLite: `"sqlite"` and an omitted value are what it already is.
 *
 * @param {unknown} storeBackend
 * @throws {TypeError} If it names no storage, or names IndexedDB.
 */
function rejectIndexedDbBackend(storeBackend) {
  validateStoreBackend(storeBackend);
  if (storeBackend === "indexeddb") {
    throw new TypeError(
      'storeBackend "indexeddb" is not available on Node.js, where the store is always SQLite'
    );
  }
}

/**
 * Creates the WasmWebClient factory for Node.js.
 *
 * Matches the browser interface:
 *   WasmWebClient.createClient(rpcUrl, noteTransportUrl, seed, storeName, logLevel, useWorker, observability, feeFaucetId, noteTransportMaxRetries, noteTransportRetryIntervalMs, callbackTimeoutMs, exclusive, storeBackend)
 *   WasmWebClient.createClientWithExternalKeystore(rpcUrl, noteTransportUrl, seed, storeName, getKey, insertKey, sign, logLevel, useWorker, observability, feeFaucetId, noteTransportMaxRetries, noteTransportRetryIntervalMs, callbackTimeoutMs)
 *   WasmWebClient.buildSwapTag(...)
 *
 * @param {object} rawSdk - The raw napi SDK module.
 * @param {object} [options]
 * @param {string} [options.dataDir] - Base directory for SQLite stores. Defaults to os.tmpdir().
 */
export function createWasmWebClient(rawSdk, options) {
  return {
    buildSwapTag: (...args) =>
      rawSdk.WebClient.buildSwapTag(...args.map(normalizeArg)),

    // The trailing parameters exist so this matches what `MidenClient.create`
    // passes the browser factory; `feeFaucetId` and the two retry options reach
    // the native client. The native store is always SQLite, so `storeBackend`
    // only has to not ask for another one.
    createClient: async (
      rpcUrl,
      noteTransportUrl,
      seed,
      storeName,
      _logLevel,
      _useWorker,
      _observability,
      feeFaucetId,
      noteTransportMaxRetries,
      noteTransportRetryIntervalMs,
      _callbackTimeoutMs,
      exclusive = false,
      storeBackend
    ) => {
      validateNoteTransportRetryOptions(
        noteTransportMaxRetries,
        noteTransportRetryIntervalMs
      );
      rejectIndexedDbBackend(storeBackend);
      // `storeIdentifier()` is the open store's SQLite path: reopen that file.
      const dbPath =
        storeName && path.isAbsolute(storeName) && storeName.endsWith(".db")
          ? storeName
          : undefined;
      const dir = dbPath
        ? path.dirname(dbPath)
        : options?.dataDir
          ? path.resolve(options.dataDir, storeName || "default")
          : storeName
            ? defaultDataDir(storeName)
            : createTempDir("client");

      const storePath = canonicalPath(
        dbPath ?? path.join(dir, `${storeName || "store"}.db`)
      );
      const releaseStore = claimStore(storePath, exclusive);
      const client = new rawSdk.WebClient();
      try {
        await client.createClient(
          rpcUrl ?? null,
          noteTransportUrl ?? null,
          normBytes(seed) ?? null,
          storePath,
          path.join(dir, "keystore"),
          feeFaucetId ?? null,
          noteTransportMaxRetries ?? null,
          noteTransportRetryIntervalMs ?? null
        );
      } catch (error) {
        releaseStore();
        throw error;
      }
      return wrapClient(client, storeName, rawSdk, releaseStore);
    },

    createClientWithExternalKeystore: async () => {
      throw new Error(
        "External keystores are not supported on Node.js. " +
          "The Node.js backend uses a filesystem keystore automatically."
      );
    },
  };
}

/**
 * Creates the MockWasmWebClient factory for Node.js.
 *
 * Matches the browser interface:
 *   MockWasmWebClient.createClient(serializedMockChain, serializedNoteTransport, seed, logLevel, storeName, storeBackend)
 *
 * @param {object} rawSdk - The raw napi SDK module.
 */
export function createMockWasmWebClient(rawSdk) {
  return {
    // The native store is always SQLite, so `storeBackend` only has to not ask
    // for another one.
    createClient: async (
      serializedMockChain,
      serializedNoteTransport,
      seed,
      _logLevel,
      _storeName,
      storeBackend
    ) => {
      rejectIndexedDbBackend(storeBackend);
      const dir = createTempDir("mock");
      const client = new rawSdk.WebClient();
      await client.createMockClient(
        path.join(dir, "store.db"),
        path.join(dir, "keystore"),
        normBytes(seed) ?? null,
        normBytes(serializedMockChain) ?? null,
        normBytes(serializedNoteTransport) ?? null
      );
      return wrapClient(client, "mock", rawSdk);
    },
  };
}
