import { AccountsResource } from "./resources/accounts.js";
import { TransactionsResource } from "./resources/transactions.js";
import { NotesResource } from "./resources/notes.js";
import { TagsResource } from "./resources/tags.js";
import { SettingsResource } from "./resources/settings.js";
import { CompilerResource } from "./resources/compiler.js";
import { KeystoreResource } from "./resources/keystore.js";
import { hashSeed } from "./utils.js";

/**
 * MidenClient wraps the existing proxy-wrapped WebClient with a resource-based API.
 *
 * Resource classes receive the proxy client and call its methods, handling all type
 * conversions (string -> AccountId, number -> BigInt, string -> enum).
 */
export class MidenClient {
  // Injected by index.js to resolve circular imports
  static _WasmWebClient = null;
  static _MockWasmWebClient = null;
  static _getWasmOrThrow = null;

  #inner;
  #getWasm;
  #terminated = false;
  #defaultProver = null;
  #isMock = false;

  constructor(inner, getWasm, defaultProver) {
    this.#inner = inner;
    this.#getWasm = getWasm;
    this.#defaultProver = defaultProver ?? null;

    this.accounts = new AccountsResource(inner, getWasm, this);
    this.transactions = new TransactionsResource(inner, getWasm, this);
    this.notes = new NotesResource(inner, getWasm, this);
    this.tags = new TagsResource(inner, getWasm, this);
    this.settings = new SettingsResource(inner, getWasm, this);
    this.compile = new CompilerResource(inner, getWasm, this);
    this.keystore = new KeystoreResource(inner, this);
  }

  /**
   * Escape hatch: runs `fn` with exclusive access to the proxied JS
   * WebClient that backs this MidenClient.
   *
   * The proxy forwards missing properties to the underlying wasm-bindgen
   * `WebClient`, so `fn` can reach lower-level methods like
   * `executeTransaction`, `proveTransaction[WithProver]`,
   * `submitProvenTransaction`, `applyTransaction`,
   * `newSendTransactionRequest`, `newConsumeTransactionRequest`, etc.
   *
   * Intended for advanced consumers that need to split the bundled
   * execute → prove → submit → apply pipeline across contexts — for example,
   * a Chrome MV3 extension that runs `executeTransaction` in its service
   * worker, dispatches the prove step to a `chrome.offscreen` document
   * (where wasm-bindgen-rayon can spawn a real thread pool), then runs
   * `submitProvenTransaction` + `applyTransaction` back in the SW.
   *
   * The callback runs inside `_serializeWasmCall`, so the WASM RefCell is
   * held for the duration of `fn`. Concurrent SDK calls (sync, other
   * transactions, etc.) queue on the same chain and run after `fn`
   * settles. Without this serialization, raw inner-client access would
   * race the proxy's chain and trip wasm-bindgen's "recursive use of an
   * object detected" panic.
   *
   * Re-entrancy: while `fn` is running, the underlying client's
   * `_withInnerLockDepth` counter is bumped so that `_serializeWasmCall`
   * invocations made BY `fn` (or any proxy-dispatched method it calls)
   * run inline rather than enqueuing on the chain. Without this, every
   * `await inner.X(...)` inside `fn` would enqueue behind the outer
   * `_withInnerWebClient` slot which is itself awaiting `fn` —
   * a classic re-entrant-lock deadlock. The depth counter restores the
   * intent of the docstring above: the lock is held for the duration
   * of `fn`, and inner-client calls "borrow" that already-held lock
   * instead of trying to re-acquire it.
   *
   * SAFETY CONTRACT for re-entrancy: callers MUST hold an external
   * mutex preventing concurrent access to this same client instance
   * via other code paths during `fn`. The chain still serializes
   * against external callers — they queue behind the outer slot — but
   * if an external task runs during one of `fn`'s awaits and calls
   * into the SDK, it will see `_withInnerLockDepth > 0` and run
   * inline, racing wasm-bindgen's borrow check. The wallet pattern
   * (own outer mutex around `_withInnerWebClient`) satisfies this.
   *
   * Stability: marked `@internal`. The shape of the proxied client is
   * intentionally not part of the documented public API and may change
   * between SDK versions. If you depend on this method, pin the SDK
   * version and test the lower-level surface carefully on each upgrade.
   * If your use case is common enough to warrant a stable public API,
   * file an issue.
   *
   * @internal
   * @template T
   * @param {(inner: object) => Promise<T>} fn - Async callback receiving
   *   the proxied JS WebClient. Must not return references that escape
   *   the callback's lifetime (the lock is released on settle).
   * @returns {Promise<T>} The resolved value of `fn`.
   */
  _withInnerWebClient(fn) {
    this.assertNotTerminated();
    if (typeof fn !== "function") {
      throw new TypeError("_withInnerWebClient: fn must be a function");
    }
    const inner = this.#inner;
    return inner._serializeWasmCall(async () => {
      inner._withInnerLockDepth = (inner._withInnerLockDepth || 0) + 1;
      try {
        return await fn(inner);
      } finally {
        inner._withInnerLockDepth--;
      }
    });
  }

  /**
   * Creates and initializes a new MidenClient.
   *
   * If no `rpcUrl` is provided, defaults to testnet with full configuration
   * (RPC, prover, note transport, autoSync).
   *
   * @param {ClientOptions} [options] - Client configuration options.
   * @returns {Promise<MidenClient>} A fully initialized client.
   */
  static async create(options) {
    if (!options?.rpcUrl) {
      return MidenClient.createTestnet(options);
    }

    const getWasm = MidenClient._getWasmOrThrow;
    const WebClientClass = MidenClient._WasmWebClient;

    if (!WebClientClass || !getWasm) {
      throw new Error(
        "MidenClient not initialized. Import from the SDK package entry point."
      );
    }

    const seed = options?.seed ? await hashSeed(options.seed) : undefined;

    const rpcUrl = resolveRpcUrl(options?.rpcUrl);
    const noteTransportUrl = resolveNoteTransportUrl(options?.noteTransportUrl);

    // `useWorker: false` opts out of the Web Worker shim that wraps every
    // WASM call. The shim exists to keep the main thread responsive in
    // browser/extension contexts, but it serializes the prover via
    // `TransactionProver.serialize()` — a format that has no encoding for
    // `newCallbackProver(jsFn)` and silently downgrades it to `"local"`.
    // Mobile/Tauri/native-prover consumers must pass `useWorker: false`.
    const useWorker = options?.useWorker;
    let inner;
    if (options?.keystore) {
      inner = await WebClientClass.createClientWithExternalKeystore(
        rpcUrl,
        noteTransportUrl,
        seed,
        options?.storeName,
        options.keystore.getKey,
        options.keystore.insertKey,
        options.keystore.sign,
        options?.debugMode,
        useWorker
      );
    } else {
      inner = await WebClientClass.createClient(
        rpcUrl,
        noteTransportUrl,
        seed,
        options?.storeName,
        options?.debugMode,
        useWorker
      );
    }

    let defaultProver = null;
    if (options?.proverUrl) {
      const wasm = await getWasm();
      defaultProver = resolveProver(options.proverUrl, wasm);
    }

    const client = new MidenClient(inner, getWasm, defaultProver);

    if (options?.autoSync) {
      await client.sync();
    }

    return client;
  }

  /**
   * Creates a client preconfigured for testnet use.
   *
   * Defaults: rpcUrl "testnet", proverUrl "testnet", noteTransportUrl "testnet", autoSync true.
   * All defaults can be overridden via options.
   *
   * @param {ClientOptions} [options] - Options to override defaults.
   * @returns {Promise<MidenClient>} A fully initialized testnet client.
   */
  static async createTestnet(options) {
    return MidenClient.create({
      rpcUrl: "testnet",
      proverUrl: "testnet",
      noteTransportUrl: "testnet",
      autoSync: true,
      ...options,
    });
  }

  /**
   * Creates a client preconfigured for devnet use.
   *
   * Defaults: rpcUrl "devnet", proverUrl "devnet", noteTransportUrl "devnet", autoSync true.
   * All defaults can be overridden via options.
   *
   * @param {ClientOptions} [options] - Options to override defaults.
   * @returns {Promise<MidenClient>} A fully initialized devnet client.
   */
  static async createDevnet(options) {
    return MidenClient.create({
      rpcUrl: "devnet",
      proverUrl: "devnet",
      noteTransportUrl: "devnet",
      autoSync: true,
      ...options,
    });
  }

  /**
   * Creates a mock client for testing.
   *
   * @param {MockOptions} [options] - Mock client options.
   * @returns {Promise<MidenClient>} A mock client.
   */
  static async createMock(options) {
    const getWasm = MidenClient._getWasmOrThrow;
    const MockWebClientClass = MidenClient._MockWasmWebClient;

    if (!MockWebClientClass || !getWasm) {
      throw new Error(
        "MidenClient not initialized. Import from the SDK package entry point."
      );
    }

    const seed = options?.seed ? await hashSeed(options.seed) : undefined;

    const inner = await MockWebClientClass.createClient(
      options?.serializedMockChain,
      options?.serializedNoteTransport,
      seed
    );

    const client = new MidenClient(inner, getWasm, null);
    client.#isMock = true;
    return client;
  }

  /** Returns the client-level default prover (set from ClientOptions.proverUrl). */
  get defaultProver() {
    return this.#defaultProver;
  }

  /**
   * Syncs the client state with the Miden node.
   *
   * @param {object} [opts] - Sync options.
   * @param {number} [opts.timeout] - Timeout in milliseconds (0 = no timeout).
   * @returns {Promise<SyncSummary>} The sync summary.
   */
  async sync(opts) {
    this.assertNotTerminated();
    return await this.#inner.syncStateWithTimeout(opts?.timeout ?? 0);
  }

  /**
   * Returns the current sync height.
   *
   * @returns {Promise<number>} The current sync height.
   */
  async getSyncHeight() {
    this.assertNotTerminated();
    return await this.#inner.getSyncHeight();
  }

  /**
   * Terminates the underlying Web Worker. After this, all method calls will throw.
   */
  terminate() {
    this.#terminated = true;
    this.#inner.terminate?.();
  }

  [Symbol.dispose]() {
    this.terminate();
  }

  async [Symbol.asyncDispose]() {
    this.terminate();
  }

  /**
   * Returns the identifier of the underlying store (e.g. IndexedDB database name, file path).
   *
   * @returns {string} The store identifier.
   */
  async storeIdentifier() {
    this.assertNotTerminated();
    return await this.#inner.storeIdentifier();
  }

  // ── Mock-only methods ──

  /** Advances the mock chain by one block. Only available on mock clients. */
  proveBlock() {
    this.assertNotTerminated();
    this.#assertMock("proveBlock");
    return this.#inner.proveBlock();
  }

  /** Returns true if this client uses a mock chain. */
  usesMockChain() {
    return this.#isMock;
  }

  /** Serializes the mock chain state for snapshot/restore in tests. */
  serializeMockChain() {
    this.assertNotTerminated();
    this.#assertMock("serializeMockChain");
    return this.#inner.serializeMockChain();
  }

  /** Serializes the mock note transport node state. */
  serializeMockNoteTransportNode() {
    this.assertNotTerminated();
    this.#assertMock("serializeMockNoteTransportNode");
    return this.#inner.serializeMockNoteTransportNode();
  }

  // ── Internal ──

  /** @internal Throws if the client has been terminated. */
  assertNotTerminated() {
    if (this.#terminated) {
      throw new Error("Client terminated");
    }
  }

  #assertMock(method) {
    if (!this.#isMock) {
      throw new Error(`${method}() is only available on mock clients`);
    }
  }
}

const RPC_URLS = {
  testnet: "https://rpc.testnet.miden.io",
  devnet: "https://rpc.devnet.miden.io",
  localhost: "http://localhost:57291",
  local: "http://localhost:57291",
};

/**
 * Resolves an rpcUrl shorthand or raw URL into a concrete endpoint string.
 *
 * @param {string | undefined} rpcUrl - "testnet", "devnet", "localhost", "local", or a raw URL.
 * @returns {string | undefined} A fully qualified URL, or undefined to use the SDK default.
 */
function resolveRpcUrl(rpcUrl) {
  if (!rpcUrl) return undefined;
  return RPC_URLS[rpcUrl.trim().toLowerCase()] ?? rpcUrl;
}

const PROVER_URLS = {
  devnet: "https://tx-prover.devnet.miden.io",
  testnet: "https://tx-prover.testnet.miden.io",
};

const NOTE_TRANSPORT_URLS = {
  testnet: "https://transport.miden.io",
  devnet: "https://transport.devnet.miden.io",
};

/**
 * Resolves a noteTransportUrl shorthand or raw URL into a concrete endpoint string.
 *
 * @param {string | undefined} noteTransportUrl - "testnet", "devnet", or a raw URL.
 * @returns {string | undefined} A fully qualified URL, or undefined if omitted.
 */
function resolveNoteTransportUrl(noteTransportUrl) {
  if (!noteTransportUrl) return undefined;
  return (
    NOTE_TRANSPORT_URLS[noteTransportUrl.trim().toLowerCase()] ??
    noteTransportUrl
  );
}

/**
 * Resolves a proverUrl shorthand or raw URL into a TransactionProver.
 *
 * @param {string} proverUrl - "local", "devnet", "testnet", or a raw URL.
 * @param {object} wasm - Loaded WASM module.
 * @returns {object} A TransactionProver instance.
 */
function resolveProver(proverUrl, wasm) {
  const normalized = proverUrl.trim().toLowerCase();
  if (normalized === "local") {
    return wasm.TransactionProver.newLocalProver();
  }
  const remoteUrl = PROVER_URLS[normalized] ?? proverUrl;
  return wasm.TransactionProver.newRemoteProver(remoteUrl, undefined);
}
