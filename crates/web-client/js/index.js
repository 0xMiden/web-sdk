import {
  validateIndexedDbOptions,
  indexedDbArgs,
  workerIndexedDbOptions,
  deliverIndexedDbFailure,
  createIndexedDbFailureSubscription,
} from "./indexeddb.js";
import loadWasm from "./wasm.js";
import { CallbackType, MethodName, WorkerAction } from "./constants.js";
import { coalesceRun, runUnderLock, withSyncLock } from "./syncLock.js";
import { emitObservation, hasObserver, setObserver } from "./observability.js";
import { MidenClient } from "./client.js";
import { CompilerResource } from "./resources/compiler.js";
import { validateNoteTransportRetryOptions } from "./utils.js";
import {
  createP2IDNote,
  createP2IDENote,
  buildSwapTag,
  buildNetworkNote,
  _setWasm as _setStandaloneWasm,
  _setWebClient as _setStandaloneWebClient,
} from "./standalone.js";
import {
  installStorageView,
  StorageView,
  StorageResult,
  wordToBigInt,
} from "./storageView.js";
import { resolveAuthScheme } from "./utils.js";
export * from "../Cargo.toml";

export {
  FaucetType,
  AuthScheme,
  NoteVisibility,
  StorageMode,
  Linking,
} from "./enums.js";

export { isConsumableNow } from "./utils.js";
export { MidenClient };
export { CompilerResource };
export { createP2IDNote, createP2IDENote, buildSwapTag, buildNetworkNote };
export { StorageView, StorageResult, wordToBigInt };

// Internal exports — used by integration tests that need direct access to the low-level WebClient proxy.
export {
  WebClient as WasmWebClient,
  MockWebClient as MockWasmWebClient,
  MockWebClient,
  withSyncLock,
};

// Method classification sets — used by scripts/check-method-classification.js to ensure
// every WASM export is explicitly categorised. Update when adding new WASM methods.
//
// Naming note: "SYNC_METHODS" is a historical misnomer. This set groups methods
// that are forwarded transparently to the underlying WASM via the Proxy in
// `createClientProxy` — meaning they don't need an explicit JS-class wrapper
// here. It does NOT mean "the method is synchronous"; some entries are
// `async fn` in Rust.
//
// What an entry DOES promise is that it takes no borrow of the client's
// `AsyncCell` at all. Raw binding skips `_serializeWasmCall`, and the hazard
// runs in both directions:
//
//   - An entry that awaits while holding the borrow can be polled concurrently
//     with any other call and panics with `already borrowed: BorrowMutError`.
//     The methods that read the store while holding the borrow — the eight
//     request constructors, `feeAwareTransactionRequestBuilder` and
//     `withFeeAwareAuth`, which read the chain's fee parameters, and
//     `buildPswapCancelByOrder`, which reads the order's lineage — are write
//     methods for this reason.
//   - An entry that takes the borrow only *synchronously* is still unsafe,
//     because a serialized method holding the borrow across an await yields to
//     the event loop with it outstanding. A raw call landing in that window
//     borrows again and panics the same way. `createCodeBuilder` and
//     `storeIdentifier` are serialized reads for this reason; they are awaited
//     at every call site, so serializing them costs nothing.
//
// `scripts/check-method-classification.js` enforces this: it reads the Rust
// sources and fails when a SYNC_METHODS entry calls `get_mut_inner`. Don't rely
// on the comment alone when adding an entry — run the script.
//
// `lastAuthError` is the one accepted exception, and the script allowlists it by
// name: it is synchronous by contract (`client.js` returns its value directly,
// and `api-types.d.ts` declares it non-Promise), so it cannot be serialized
// without a breaking change. The `keystore` getter has the same shape and is not
// a method, so the classification script never sees it. Both take a shared
// borrow, so both can still lose the race above — don't add a third.
const SYNC_METHODS = new Set([
  "buildSwapTag",
  "lastAuthError",
  "proveBlock",
  "serializeMockChain",
  "serializeMockNoteTransportNode",
  "usesMockChain",
]);

// The instance members whose live call returns a value rather than a Promise,
// so a terminated client's copy throws instead of rejecting. Not SYNC_METHODS:
// four of its entries are `async fn` in Rust, and `buildSwapTag` is a static of
// the class, which the proxy never serves.
const SYNCHRONOUS_METHODS = new Set(["lastAuthError"]);

const WRITE_METHODS = new Set([
  "addAccountSecretKeyToWebStore",
  "addTag",
  "buildPswapCancelByOrder",
  "chainAnchorForRequest",
  "executeForSummary",
  "executeForSummaryAt",
  "feeAwareTransactionRequestBuilder",
  "fetchPrivateNotes",
  "forceImportStore",
  "importAccountById",
  "importAccountFile",
  "importNoteFile",
  "insertAccountAddress",
  "newAccount",
  "newB2AggTransactionRequest",
  "newConsumeTransactionRequest",
  "newMintTransactionRequest",
  "newPswapCancelTransactionRequest",
  "newPswapConsumeTransactionRequest",
  "newPswapCreateTransactionRequest",
  "newSendTransactionRequest",
  "newSwapTransactionRequest",
  "pruneAccountHistory",
  "registerAccount",
  "removeAccountAddress",
  "removeTag",
  "removeSetting",
  "sendPrivateNote",
  "sendPrivateOutputNote",
  "setSetting",
  "submitNewTransactionBatch",
  "submitProvenTransaction",
  "withFeeAwareAuth",
]);

const READ_METHODS = new Set([
  "accountReader",
  "createCodeBuilder",
  "exportAccountFile",
  "getAccountAuthByPubKeyCommitment",
  "getAccountByKeyCommitment",
  "exportNoteFile",
  "exportStore",
  "getAccount",
  "getAccountCode",
  "getAccountStorage",
  "getAccountVault",
  "getAccounts",
  "getConsumableNotes",
  "getInputNote",
  "getInputNotes",
  "getOutputNote",
  "getOutputNotes",
  "getPswapLineage",
  "getPswapLineages",
  "getPswapLineagesFor",
  "getPublicKeyCommitmentsOfAccount",
  "getSetting",
  "getSyncHeight",
  "getTransactions",
  "isAccountAllowed",
  "isInvitationCodeValid",
  "listSettingKeys",
  "listTags",
  "executeProgram",
  "feeFaucetId",
  "storeIdentifier",
]);

const MOCK_STORE_NAME = "mock_client_db";

// SYNC_METHODS is consumed by `createClientProxy`; WRITE_METHODS and
// READ_METHODS exist solely for the CI lint check
// (scripts/check-method-classification.js); suppress unused-variable
// warnings for those two.
void WRITE_METHODS;
void READ_METHODS;

const buildTypedArraysExport = (exportObject) => {
  return Object.entries(exportObject).reduce(
    (exports, [exportName, _export]) => {
      if (exportName.endsWith("Array")) {
        exports[exportName] = _export;
      }
      return exports;
    },
    {}
  );
};

const deserializeError = (errorLike) => {
  if (!errorLike) {
    return new Error("Unknown error received from worker");
  }
  const { name, message, stack, cause, ...rest } = errorLike;
  const reconstructedError = new Error(message ?? "Unknown worker error");
  reconstructedError.name = name ?? reconstructedError.name;
  if (stack) {
    reconstructedError.stack = stack;
  }
  if (cause) {
    reconstructedError.cause = deserializeError(cause);
  }
  Object.entries(rest).forEach(([key, value]) => {
    if (value !== undefined) {
      reconstructedError[key] = value;
    }
  });
  return reconstructedError;
};

export const MidenArrays = {};

let wasmModule = null;
let wasmLoadPromise = null;
let webClientStaticsCopied = false;

const ensureWasm = async () => {
  if (wasmModule) {
    return wasmModule;
  }
  if (!wasmLoadPromise) {
    wasmLoadPromise = loadWasm().then((module) => {
      wasmModule = module;
      if (module) {
        Object.assign(MidenArrays, buildTypedArraysExport(module));
        if (!webClientStaticsCopied && module.WebClient) {
          copyWebClientStatics(module.WebClient);
          webClientStaticsCopied = true;
        }
        // Set WASM module for standalone utilities
        _setStandaloneWasm(module);
        // Install StorageView: account.storage() now returns a developer-friendly
        // wrapper that makes getItem() work correctly for StorageMap slots.
        installStorageView(module);
      }
      return module;
    });
  }
  return wasmLoadPromise;
};

export const getWasmOrThrow = async () => {
  const module = await ensureWasm();
  if (!module) {
    throw new Error(
      "Miden WASM bindings are unavailable in this environment (SSR is disabled)."
    );
  }
  return module;
};
/**
 * WebClient is a wrapper around the underlying WASM WebClient object.
 *
 * This wrapper serves several purposes:
 *
 * 1. It creates a dedicated web worker to offload computationally heavy tasks
 *    (such as creating accounts, executing transactions, submitting transactions, etc.)
 *    from the main thread, helping to prevent UI freezes in the browser.
 *
 * 2. It defines methods that mirror the API of the underlying WASM WebClient,
 *    with the intention of executing these functions via the web worker. This allows us
 *    to maintain the same API and parameters while benefiting from asynchronous, worker-based computation.
 *
 * 3. It employs a Proxy to forward any calls not designated for web worker computation
 *    directly to the underlying WASM WebClient instance.
 *
 * Additionally, the wrapper provides a static createClient function. This static method
 * instantiates the WebClient object and ensures that the necessary createClient calls are
 * performed both in the main thread and within the worker thread. This dual initialization
 * correctly passes user parameters (RPC URL and seed) to both the main-thread
 * WASM WebClient and the worker-side instance.
 *
 * Because of this implementation, the only breaking change for end users is in the way the
 * web client is instantiated. Users should now use the WebClient.createClient static call.
 */
/**
 * Create a Proxy that forwards missing properties to the underlying WASM
 * WebClient.
 */
let sensitiveWarningEmitted = false;

/**
 * Apply the observability fields of `ClientOptions`. Enabling the
 * high-fidelity channel warns once per process: routing account ids and raw
 * error text into a third party should never happen by accident.
 *
 * The flag is deliberately `=== true` rather than truthy. A `"true"` from an
 * env var, a query string, or a JSON round-trip is far likelier to be a
 * wiring mistake than a decision to disclose user data, and the safe reading
 * of an ambiguous value is "off".
 *
 * @param {{observer?: (o: object) => void, observeSensitive?: boolean}} [options]
 * @returns {boolean} whether the high-fidelity channel is enabled
 */
function applyObserverOptions(options) {
  if (typeof options?.observer === "function") {
    setObserver(options.observer);
  }
  const observeSensitive = options?.observeSensitive === true;
  if (observeSensitive && !sensitiveWarningEmitted) {
    sensitiveWarningEmitted = true;
    console.warn(
      "[miden-sdk] observeSensitive is enabled: observations will carry account " +
        "identifiers and raw error text. Do not enable this in an application " +
        "that must not disclose user data to its telemetry provider."
    );
  }
  return observeSensitive;
}

function createClientProxy(instance) {
  return new Proxy(instance, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      const live = target.wasmWebClient;
      // After terminate() only a read nested in an in-flight
      // `_withInnerWebClient` keeps the live route, as in `_serializeWasmCall`:
      // it belongs to work that was already queued when terminate() ran.
      const liveRoute =
        live && (!target._terminated || target._withInnerLockDepth > 0);
      if (liveRoute && prop in live) {
        const value = live[prop];
        if (typeof value === "function") {
          // SYNC_METHODS are safe to bind raw (synchronous in JS, or
          // documented exceptions). Everything else holds the WASM
          // client's internal RefCell across its awaits, so it MUST join
          // `_serializeWasmCall` — an unserialized fallback overlapping
          // any in-flight call panics with "RefCell already borrowed"
          // and poisons the instance for every later call.
          if (typeof prop === "string" && SYNC_METHODS.has(prop)) {
            return (...args) => {
              const result = value.apply(live, args);
              if (typeof result?.then === "function") {
                target._trackRawWasmCall(result);
              }
              return result;
            };
          }
          return (...args) =>
            target._serializeWasmCall(
              () => value.apply(target.wasmWebClient, args),
              prop
            );
        }
        return value;
      }
      // After terminate(), whether or not the wasm client has been freed yet,
      // each of its members fails in its live call shape instead of vanishing:
      // an accessor throws on access, a synchronous method throws, every other
      // method rejects. Never for "then", which would make the proxy itself
      // look like a promise.
      const members = target._terminated
        ? (target._freedWasmPrototype ?? (live && Object.getPrototypeOf(live)))
        : null;
      if (
        members &&
        typeof prop === "string" &&
        prop !== "then" &&
        prop in members
      ) {
        const terminated = () => new Error("WebClient terminated");
        if (Object.getOwnPropertyDescriptor(members, prop)?.get) {
          throw terminated();
        }
        if (SYNCHRONOUS_METHODS.has(prop)) {
          return () => {
            throw terminated();
          };
        }
        return () => Promise.reject(terminated());
      }
      return undefined;
    },
  });
}

class WebClient {
  /**
   * Controls which worker variant is spawned when a WebClient is constructed.
   *
   * - `"auto"` (default): pick `classic` on Safari/WKWebView (where module
   *   workers have a very slow cold start), `module` everywhere else.
   * - `"module"`: always use the `.mjs` ES-module worker. Required for webpack
   *   5 / Next.js consumers so the asset tracer can see the WASM URL.
   * - `"classic"`: always use the `.js` classic-script worker. Required on
   *   Safari/WKWebView. Set this if your consumer bundler (or your host app)
   *   does not support module workers.
   *
   * Set before the first `WebClient.createClient(...)` call.
   */
  static workerMode = "auto";

  /**
   * Decide between the module and classic worker variants based on
   * `WebClient.workerMode` and (when `auto`) the current user agent.
   * @returns {boolean} true when the classic script should be used.
   * @private
   */
  static _shouldUseClassicWorker() {
    const mode = WebClient.workerMode;
    if (mode === "module") return false;
    if (mode === "classic") return true;
    // auto: classic on Safari/WKWebView, module everywhere else.
    const ua =
      typeof navigator !== "undefined" && navigator.userAgent
        ? navigator.userAgent
        : "";
    // Chromium-based browsers (Chrome, Edge, Brave, Opera, Chromium-based
    // Android WebView) handle module workers fine.
    if (/Chrome\/|Chromium\//.test(ua)) return false;
    // Safari (desktop + iOS) and WKWebView-without-Chrome (e.g. Capacitor host)
    // both have AppleWebKit but no Chrome/Chromium in the UA. Prefer classic.
    if (/AppleWebKit/.test(ua)) return true;
    // Firefox, jsdom, node without navigator, etc. — module worker is fine.
    return false;
  }

  /**
   * Create a WebClient wrapper.
   *
   * @param {string | undefined} rpcUrl - RPC endpoint URL used by the client.
   * @param {Uint8Array | undefined} seed - Optional seed for account initialization.
   * @param {string | undefined} storeName - Optional name for the store to be used by the client.
   * @param {(pubKey: Uint8Array) => Promise<Uint8Array | null | undefined> | Uint8Array | null | undefined} [getKeyCb]
   *   - Callback to retrieve the secret key bytes for a given public key. The `pubKey`
   *   parameter is the serialized public key (from `PublicKey.serialize()`). Return the
   *   corresponding secret key as a `Uint8Array`, or `null`/`undefined` if not found. The
   *   return value may be provided synchronously or via a `Promise`.
   * @param {(pubKey: Uint8Array, AuthSecretKey: Uint8Array) => Promise<void> | void} [insertKeyCb]
   *   - Callback to persist a secret key. `pubKey` is the serialized public key, and
   *   `authSecretKey` is the serialized secret key (from `AuthSecretKey.serialize()`). May return
   *   `void` or a `Promise<void>`.
   * @param {(pubKey: Uint8Array, signingInputs: Uint8Array) => Promise<Uint8Array> | Uint8Array} [signCb]
   *   - Callback to produce serialized signature bytes for the provided inputs. `pubKey` is the
   *   serialized public key, and `signingInputs` is a `Uint8Array` produced by
   *   `SigningInputs.serialize()`. Must return a `Uint8Array` containing the serialized
   *   signature, either directly or wrapped in a `Promise`.
   * @param {string | undefined} [logLevel] - Optional log verbosity level
   *   ("error", "warn", "info", "debug", "trace", "off", or "none").
   *   When set, Rust tracing output is routed to the browser console.
   * @param {boolean} [useWorker=true] - When `false`, skip the Web Worker shim
   *   and call the wasm-bindgen `WebClient` directly on the current thread.
   *   The worker exists to keep the main thread responsive during WASM work
   *   in browser/extension contexts, but it serializes the prover argument
   *   via `TransactionProver.serialize()` — a format that has no encoding
   *   for `newCallbackProver(jsFn)` and silently downgrades it to `"local"`.
   *   Consumers that hand a `CallbackProver` (e.g. native iOS/Android plug-in
   *   provers in Capacitor apps, or any other JS-side prover bridge) need
   *   `useWorker: false` so the prover handle reaches the WASM binding intact.
   * @param {{observer?: (observation: object) => void, observeSensitive?: boolean}} [observability]
   *   - Observability fields of `ClientOptions`. `observer` is registered as
   *   the process-wide observation sink; `observeSensitive` decides, for this
   *   client and for its whole lifetime, whether observations carry the
   *   high-fidelity `sensitive` channel. Both are construction-only.
   * @param {string | undefined} [feeFaucetId] - Faucet of the chain's fee asset,
   *   as a bech32 address or a hex account ID. Optional: the client receives the
   *   protocol configuration, which names the fee asset, from the node when it
   *   syncs, so this only sets what `feeFaucetId()` reports before the first sync.
   * @param {number | undefined} [noteTransportMaxRetries] - Retries of a private
   *   note send after a transient transport failure, an integer from 0 to 10.
   *   Defaults to 3. `0` bounds a send to one attempt, which suits a
   *   latency-sensitive UI: the retries run inside this client's serialized
   *   call, so a slow or rate-limiting transport blocks every other call until
   *   the send finishes. A non-zero service `retry-after` replaces the computed
   *   delay with no upper bound; a zero one falls back to it.
   * @param {number | undefined} [noteTransportRetryIntervalMs] - Delay before
   *   the first such retry, doubling for each later one, an integer from 0 to
   *   60000. Defaults to 250. With the retries, the total computed backoff
   *   `interval * (2^retries - 1)`, an omitted value taken at its default, may
   *   not exceed 120000 ms.
   * @throws {TypeError} If either retry option is out of range or their total
   *   backoff exceeds 120000 ms. Checked here, before any worker or WASM call,
   *   so every way of building a client rejects the same values.
   */
  constructor(
    rpcUrl,
    noteTransportUrl,
    seed,
    storeName,
    getKeyCb,
    insertKeyCb,
    signCb,
    logLevel,
    useWorker = true,
    observability,
    feeFaucetId,
    noteTransportMaxRetries,
    noteTransportRetryIntervalMs,
    indexedDb
  ) {
    validateNoteTransportRetryOptions(
      noteTransportMaxRetries,
      noteTransportRetryIntervalMs
    );
    const storageOptions = validateIndexedDbOptions(indexedDb);
    const storageSubscription = createIndexedDbFailureSubscription(
      storageOptions?.onFailure,
      () => !this._terminated
    );
    this._releaseStorageCallback = storageSubscription.dispose;
    this._indexedDb =
      storageOptions === undefined
        ? undefined
        : {
            durability: storageOptions.durability,
            onFailure: storageOptions.onFailure
              ? storageSubscription.notify
              : undefined,
          };
    this.rpcUrl = rpcUrl;
    this.noteTransportUrl = noteTransportUrl;
    this.seed = seed;
    this.storeName = storeName;
    this.getKeyCb = getKeyCb;
    this.insertKeyCb = insertKeyCb;
    this.signCb = signCb;
    this.logLevel = logLevel;
    // Stored under a private name on purpose: `createClientProxy` forwards only
    // properties MISSING from this instance (`prop in target` wins), so an own
    // property called `feeFaucetId` would shadow the WASM accessor of that name
    // and `client.feeFaucetId()` would return this string instead of calling it.
    this._feeFaucetId = feeFaucetId;
    this._noteTransportMaxRetries = noteTransportMaxRetries;
    this._noteTransportRetryIntervalMs = noteTransportRetryIntervalMs;
    this.useWorker = useWorker !== false;

    // Check if Web Workers are available AND the caller didn't opt out via
    // `useWorker: false`. The opt-out is load-bearing for `CallbackProver`
    // consumers — see the constructor doc above.
    if (this.useWorker && typeof Worker !== "undefined") {
      console.log("WebClient: Web Workers are available.");
      // Pick between the module and classic worker variants at runtime — see
      // `WebClient.workerMode` below. Both branches keep the
      // `new Worker(new URL("...", import.meta.url), ...)` form fully literal:
      // webpack 5's new-worker detector is PURELY SYNTACTIC and only triggers
      // a proper worker sub-compilation (with asset+chunk tracing into the
      // Cargo glue and the sibling WASM) when it sees that exact pattern
      // spelled inline. Hoisting either URL into a variable downgrades the
      // detection to a plain "copy file as asset" — which in turn makes the
      // worker's `await import("./Cargo-*.js")` 404 because webpack never
      // emitted a chunk for it. The bit of duplication here is load-bearing.
      //
      // - module (`.module.js` with `{ type: "module" }`): `import.meta.url`
      //   inside the Cargo glue is preserved so webpack/Vite can resolve the
      //   WASM URL statically. Preferred everywhere EXCEPT Safari/WKWebView.
      // - classic (`.js`, no options): self-contained async IIFE with
      //   `import.meta.url` rewritten to `self.location.href`; the only form
      //   Safari/WKWebView can cold-start in a reasonable time.
      if (WebClient._shouldUseClassicWorker()) {
        this.worker = new Worker(
          new URL("./workers/web-client-methods-worker.js", import.meta.url)
        );
      } else {
        this.worker = new Worker(
          new URL(
            "./workers/web-client-methods-worker.module.js",
            import.meta.url
          ),
          { type: "module" }
        );
      }

      // Map to track pending worker requests.
      this.pendingRequests = new Map();

      // Promises to track when the worker script is loaded and ready.
      this.loaded = new Promise((resolve) => {
        this.loadedResolver = resolve;
      });

      // Create a promise that resolves when the worker signals that it is
      // fully initialized, and rejects if initialization fails. Every
      // worker-forwarded method awaits `ready` first, so an init failure must
      // reject it — otherwise those calls would await a promise that never
      // settles and hang forever.
      this.ready = new Promise((resolve, reject) => {
        this.readyResolver = resolve;
        this.readyRejecter = reject;
      });
      // Init can fail before any caller awaits `ready`; this no-op handler
      // suppresses the unhandledrejection event without consuming the
      // rejection for real awaiters.
      this.ready.catch(() => {});

      // Listen for messages from the worker.
      this.worker.addEventListener("message", async (event) => {
        const data = event.data;
        if (data.action === WorkerAction.STORAGE_FAILURE) {
          if (!this._terminated)
            deliverIndexedDbFailure(this._indexedDb?.onFailure, data.failure);
          return;
        }

        // Worker script loaded.
        if (data.loaded) {
          this.loadedResolver();
          return;
        }

        // Worker ready.
        if (data.ready) {
          this.readyResolver();
          return;
        }

        if (data.action === WorkerAction.EXECUTE_CALLBACK) {
          const { callbackType, args, requestId } = data;
          try {
            const callbackMapping = {
              [CallbackType.GET_KEY]: this.getKeyCb,
              [CallbackType.INSERT_KEY]: this.insertKeyCb,
              [CallbackType.SIGN]: this.signCb,
            };
            if (!callbackMapping[callbackType]) {
              throw new Error(`Callback ${callbackType} not available`);
            }
            const callbackFunction = callbackMapping[callbackType];
            let result = callbackFunction.apply(this, args);
            if (result instanceof Promise) {
              result = await result;
            }

            this.worker.postMessage({
              callbackResult: result,
              callbackRequestId: requestId,
            });
          } catch (error) {
            this.worker.postMessage({
              callbackError: error.message,
              callbackRequestId: requestId,
            });
          }
          return;
        }

        // Handle responses for method calls.
        const { requestId, error, result, methodName } = data;
        if (requestId && this.pendingRequests.has(requestId)) {
          const { resolve, reject } = this.pendingRequests.get(requestId);
          this.pendingRequests.delete(requestId);
          if (error) {
            const workerError =
              error instanceof Error ? error : deserializeError(error);
            console.error(
              `WebClient: Error from worker in ${methodName}:`,
              workerError
            );
            reject(workerError);
          } else {
            resolve(result);
          }
          return;
        }

        // An error with no request attached comes from worker initialization
        // (INIT is the only requestId-less action that can fail). Reject
        // `ready` so queued and future method calls fail with the real cause
        // instead of awaiting forever.
        if (error && !requestId) {
          const workerError =
            error instanceof Error ? error : deserializeError(error);
          console.error(
            "WebClient: worker initialization failed:",
            workerError
          );
          this.readyRejecter(workerError);
        }
      });

      // Once the worker script has loaded, initialize the worker.
      this.loaded.then(() => this.initializeWorker());
    } else {
      console.log(
        this.useWorker
          ? "WebClient: Web Workers are not available."
          : "WebClient: Web Worker shim disabled by caller (useWorker=false)."
      );
      // Worker not available or explicitly disabled; set up fallback values.
      this.worker = null;
      this.pendingRequests = null;
      this.loaded = Promise.resolve();
      this.ready = Promise.resolve();
    }

    // Lazy initialize the underlying WASM WebClient when first requested.
    this.wasmWebClient = null;
    this.wasmWebClientPromise = null;

    // Promise chain to serialize direct WASM calls that require exclusive
    // (&mut self) access. Without this, concurrent calls on the same client
    // would panic with "recursive use of an object detected" due to
    // wasm-bindgen's internal RefCell.
    this._wasmCallChain = Promise.resolve();
    // Depth counter for `_withInnerWebClient` re-entrancy. While > 0,
    // `_serializeWasmCall` runs its callback inline instead of queueing
    // it on the chain — see the comment on `_serializeWasmCall` for the
    // safety contract.
    this._withInnerLockDepth = 0;
    // This client's in-flight coalesced syncs; see `_withStoreLock`.
    this._syncRuns = new Map();
    // Top-level calls queued on `_wasmCallChain` so far. A coalesced sync run
    // is joinable only until it moves; see `_withStoreLock`.
    this._queuedCalls = 0;

    // The high-fidelity channel is decided here and nowhere else. Writing it
    // as a non-writable, non-configurable property means no later assignment
    // — by a consumer holding the inner client, by a plugin, or by our own
    // code — can turn on the disclosure of account identifiers and raw error
    // text for a client that was not constructed with it. Enabling it must
    // be a deliberate, auditable act at one call site.
    Object.defineProperty(this, "_observeSensitive", {
      value: applyObserverOptions(observability),
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  /**
   * Serialize a WASM call that requires exclusive (&mut self) access.
   * Concurrent calls are queued and executed one at a time.
   *
   * Wraps both the direct (in-thread) path and the worker-dispatched path.
   * On the worker path this is redundant with the worker's own message queue,
   * but harmless (the chain resolves immediately on the main thread once the
   * worker's postMessage returns). On the direct path it is load-bearing —
   * without it, concurrent main-thread callers would panic with
   * "recursive use of an object detected" (wasm-bindgen's internal RefCell).
   *
   * Re-entrancy: when invoked from inside a `_withInnerWebClient(fn)`
   * callback — detected via `_withInnerLockDepth > 0` — `fn` runs inline
   * (no chain enqueue). The outer `_withInnerWebClient` invocation
   * already holds the chain via its own wrapping `_serializeWasmCall`,
   * so enqueueing the inner call would deadlock (the inner queues
   * behind the outer; the outer awaits the inner). The inline run is
   * safe because the chain still serializes against external callers
   * — they queue behind the outer call's chain slot, which only resolves
   * after `fn` (including all inline re-entries) settles. Callers of
   * `_withInnerWebClient` MUST hold an external mutex preventing
   * concurrent access via other code paths on this same instance during
   * the callback; without that, an external task running between two
   * awaits inside `fn` would race wasm-bindgen's borrow check.
   *
   * Observability: when `opName` is supplied and a consumer has registered an
   * observer, one observation (name, outcome, duration) is emitted after the
   * call settles. The emission is additive — it never alters the value, the
   * error, the ordering, or the chain — and a throwing observer is swallowed
   * by the sink, so telemetry cannot fail an operation.
   *
   * The observation's safe fields carry no identifier and no error text, so
   * they are fit to send anywhere. Verbatim error detail goes in `sensitive`,
   * which is populated only on failure and only when this client was
   * constructed with `observeSensitive: true`. There is deliberately no
   * per-call way to ask for it: the flag comes from the instance, which
   * sealed it at construction.
   *
   * @param {() => Promise<any>} fn - The async function to execute.
   * @param {string} [opName] - Operation name to observe this call under.
   *   Omit to leave the call unobserved.
   * @returns {Promise<any>} The result of fn.
   */
  _serializeWasmCall(fn, opName) {
    // A call nested in an in-flight `_withInnerWebClient` still runs inline:
    // it belongs to work that was already queued when terminate() ran.
    if (this._terminated && this._withInnerLockDepth === 0) {
      return Promise.reject(new Error("WebClient terminated"));
    }
    // Opt-in twice over: with no op name or nobody listening, `fn` is
    // enqueued exactly as before and no timing work is done at all.
    const observed = opName !== undefined && hasObserver();
    const wrapped = observed
      ? async () => {
          const startedAt = performance.now();
          try {
            const value = await fn();
            emitObservation({
              op: opName,
              outcome: "ok",
              durationMs: performance.now() - startedAt,
            });
            return value;
          } catch (error) {
            // Built only when the channel is on, and left off the
            // observation entirely otherwise — not as `undefined`, not as an
            // empty object. A consumer branching on
            // `"sensitive" in observation` has to be able to tell "not
            // enabled" from "enabled but nothing to report".
            const sensitive =
              this._observeSensitive === true
                ? {
                    errorMessage:
                      error instanceof Error ? error.message : String(error),
                    ...(error instanceof Error && error.stack
                      ? { errorStack: error.stack }
                      : {}),
                  }
                : undefined;
            emitObservation({
              op: opName,
              outcome: "error",
              durationMs: performance.now() - startedAt,
              ...(sensitive !== undefined ? { sensitive } : {}),
            });
            throw error;
          }
        }
      : fn;

    if (this._withInnerLockDepth > 0) {
      return Promise.resolve().then(wrapped);
    }
    this._queuedCalls += 1;
    const result = this._wasmCallChain.catch(() => {}).then(wrapped);
    this._wasmCallChain = result.catch(() => {});
    return result;
  }

  /**
   * The id the store lock is keyed by: the name of the store this client
   * opens, which its factory resolves with `resolveStoreName`, the derivation
   * `createClient` names the store with, so clients that reach one store by
   * different arguments take one lock. A `MockWebClient`, whose store name is
   * fixed, and an instance built without a factory are keyed by the store
   * name they were constructed with.
   * @private
   */
  _storeLockId() {
    return this._openedStoreName ?? this.storeName ?? "default";
  }

  /**
   * Runs `fn` on this instance's call chain while holding the store lock, the
   * per-store Web Lock of `syncLock.js`, so every call that writes the chain
   * MMR or its tracked block headers excludes every other such call on the
   * same store, across instances, tabs and workers. One that interleaves
   * corrupts the MMR for good: a note import reads the partial MMR, awaits
   * the node, then stores a header whose path is trimmed to the forest it
   * read, and a sync committing new peaks in between leaves that path too
   * short.
   *
   * The lock is per store opened (see `_storeLockId`): a client that omits
   * `storeName` and one naming the same default store take one lock, and
   * clients on different default stores do not block each other.
   *
   * The calls that take it: `syncState`, `syncChain` and `syncNoteTransport`
   * on `WebClient` and `MockWebClient`, `importNoteFile` and
   * `fetchPrivateNotes`, all through this method; and
   * `syncBeforeAccountCreation` and account creation (`newWallet`,
   * `newFaucet`, `newAccount`, `newAccountWithSecretKey`), which request and
   * wait for it only on a store still at genesis, for the sync a creation
   * runs first there (see `_syncIfAtGenesis`). A creation takes the lock only
   * for that sync, inside its own call (see `_createAccount`), and releases
   * it before it generates a key, stores the account or calls an external
   * keystore's `insertKey`, so no application callback runs under the lock.
   * Two writes take no lock: the free `importStore` function, which replaces a
   * whole store, and the genesis block header `createClient` stores in a store
   * that has none. The shipped `frontend-pitfalls` skill keeps the consumer
   * copy of this list.
   *
   * Lock order is always call chain, then store lock: the call takes its
   * chain slot when it is made, like any other call, and requests the lock
   * when that slot starts. So call order, `terminate()` and `waitForIdle()`
   * treat it like any other call, and a lock holder never waits for a
   * callback of its own instance. A call waiting for another instance's
   * holder holds this instance's chain meanwhile, and its observation, named
   * by `opName`, includes that wait.
   *
   * `syncMethod` lets a call of that sync join this instance's pending run of
   * it, registered when the run's own call was made, but only while no other
   * call has been queued on this instance's chain since. A later call ends
   * the run's joining window, and the next call of the sync starts a run of
   * its own behind it, so a joiner never settles ahead of a call made before
   * it, and back-to-back calls of the sync with nothing between share one
   * run. Calls nested in `_withInnerWebClient` and the release `terminate()`
   * queues do not end the window. The run is on this instance's chain, so
   * call order, `waitForIdle()` and `terminate()` cover every caller sharing
   * it. The registry is this instance's own: a sync on another instance never
   * joins the run, but runs its own, serialized with it by the store lock.
   * Without `syncMethod` every call runs its own `fn`.
   *
   * Nested in `_withInnerWebClient`, the call runs inline like any nested call
   * and requests the lock itself. It never joins a coalesced run, which may
   * be queued behind the callback.
   *
   * @param {() => Promise<any>} fn - The WASM work.
   * @param {string} [opName] - Operation name, as for `_serializeWasmCall`.
   * @param {string} [syncMethod] - The sync method to coalesce under.
   * @returns {Promise<any>} The result of fn.
   * @private
   */
  _withStoreLock(fn, opName, syncMethod) {
    // `_serializeWasmCall` rejects too, but a joiner never reaches it.
    if (this._terminated && this._withInnerLockDepth === 0) {
      return Promise.reject(new Error("WebClient terminated"));
    }
    const dbId = this._storeLockId();
    const run = () =>
      this._serializeWasmCall(() => runUnderLock(dbId, fn), opName);
    if (!syncMethod || this._withInnerLockDepth > 0) {
      return run();
    }
    return coalesceRun(
      dbId,
      syncMethod,
      run,
      this._syncRuns,
      () => this._queuedCalls
    );
  }

  /**
   * Returns a promise that resolves once every serialized WASM call that
   * was already on `_wasmCallChain` when `waitForIdle()` was called has
   * settled. Use this from callers that need to perform a non-WASM-side
   * action (e.g. clear an in-memory auth key) AFTER any in-flight
   * execute / submit / sync has completed, so the WASM kernel's auth
   * callback doesn't race with the key being cleared.
   *
   * Does NOT wait for calls enqueued after `waitForIdle()` returns —
   * this is intentional, so a caller can drain and then proceed without
   * being blocked indefinitely by a concurrent workload.
   *
   * A call that takes the store lock is on the chain from the moment it is
   * made, like every other serialized call; see `_withStoreLock`.
   *
   * @returns {Promise<void>}
   */
  async waitForIdle() {
    // Chain on `_wasmCallChain`; by the time this resolves, any in-flight
    // serialized call has settled. Catch so the chain state doesn't leak.
    await this._wasmCallChain.catch(() => {});
  }

  // TODO: This will soon conflict with some changes in main.
  // More context here:
  // https://github.com/0xMiden/miden-client/pull/1645?notification_referrer_id=NT_kwHOA1yg7NoAJVJlcG9zaXRvcnk7NjU5MzQzNzAyO0lzc3VlOzM3OTY4OTU1Nzk&notifications_query=is%3Aunread#discussion_r2696075480
  initializeWorker() {
    // Pass `numThreads` to the worker so it can call `wasm.initThreadPool(n)`
    // inside its OWN WASM instance — the SDK worker's instance is separate
    // from the main thread's, and rayon's global pool is per-instance.
    // Default: navigator.hardwareConcurrency (or 1 if unavailable for any
    // reason — e.g. the page isn't crossOriginIsolated, in which case the
    // worker will skip pool init and parallelism falls back to sequential).
    let numThreads = 1;
    try {
      if (
        typeof self !== "undefined" &&
        self.crossOriginIsolated &&
        navigator?.hardwareConcurrency
      ) {
        numThreads = navigator.hardwareConcurrency;
      }
    } catch {}
    this.worker.postMessage({
      action: WorkerAction.INIT,
      args: [
        this.rpcUrl,
        this.noteTransportUrl,
        this.seed,
        this.storeName,
        !!this.getKeyCb,
        !!this.insertKeyCb,
        !!this.signCb,
        this.logLevel,
        numThreads,
        this._feeFaucetId,
        this._noteTransportMaxRetries,
        this._noteTransportRetryIntervalMs,
        ...indexedDbArgs(workerIndexedDbOptions(this._indexedDb)),
      ],
    });
  }

  async getWasmWebClient() {
    if (this.wasmWebClient) {
      return this.wasmWebClient;
    }
    if (this._terminated) {
      throw new Error("WebClient terminated");
    }
    if (!this.wasmWebClientPromise) {
      this.wasmWebClientPromise = (async () => {
        const wasm = await getWasmOrThrow();
        const client = new wasm.WebClient();
        this.wasmWebClient = client;
        return client;
      })();
    }
    return this.wasmWebClientPromise;
  }

  /**
   * Factory method to create and initialize a WebClient instance.
   * This method is async so you can await the asynchronous call to createClient().
   *
   * @param {string} rpcUrl - The RPC URL.
   * @param {string} noteTransportUrl - The note transport URL (optional).
   * @param {string} seed - The seed for the account.
   * @param {string | undefined} network - Optional name for the store. Setting this allows multiple clients to be used in the same browser.
   * @param {string | undefined} logLevel - Optional log verbosity level ("error", "warn", "info", "debug", "trace", "off", or "none").
   * @param {boolean} [useWorker=true] - When `false`, bypass the Web Worker shim
   *   and run WASM calls on the current thread. Required for `CallbackProver`
   *   consumers (the worker path serializes the prover and loses the callback).
   * @returns {Promise<WebClient>} The fully initialized WebClient.
   * @param {{observer?: (observation: object) => void, observeSensitive?: boolean}} [observability]
   *   - Observability fields of `ClientOptions`; see the constructor.
   * @param {string | undefined} feeFaucetId - Fee faucet of the chain, as a bech32 address or a
   *   hex account ID. Optional: the client receives the protocol configuration, which names the
   *   fee asset, from the node when it syncs, so this only sets what `feeFaucetId()` reports
   *   before the first sync.
   * @param {number | undefined} [noteTransportMaxRetries] - Retries of a private note send
   *   after a transient transport failure; see the constructor.
   * @param {number | undefined} [noteTransportRetryIntervalMs] - Delay before the first such
   *   retry; see the constructor.
   */
  static async createClient(
    rpcUrl,
    noteTransportUrl,
    seed,
    network,
    logLevel,
    useWorker = true,
    observability,
    feeFaucetId,
    noteTransportMaxRetries,
    noteTransportRetryIntervalMs,
    indexedDb
  ) {
    // Construct the instance (synchronously).
    const instance = new WebClient(
      rpcUrl,
      noteTransportUrl,
      seed,
      network,
      undefined,
      undefined,
      undefined,
      logLevel,
      useWorker,
      observability,
      feeFaucetId,
      noteTransportMaxRetries,
      noteTransportRetryIntervalMs,
      indexedDb
    );

    try {
      // Set up logging on the main thread before creating the client.
      if (logLevel) {
        const wasm = await getWasmOrThrow();
        wasm.setupLogging(logLevel);
      }

      // Wait for the underlying wasmWebClient to be initialized.
      const wasmWebClient = await instance.getWasmWebClient();
      // Keys the store lock; see `_storeLockId`.
      instance._openedStoreName = (await getWasmOrThrow()).resolveStoreName(
        rpcUrl,
        network
      );
      await wasmWebClient.createClient(
        rpcUrl,
        noteTransportUrl,
        seed,
        network,
        feeFaucetId,
        noteTransportMaxRetries,
        noteTransportRetryIntervalMs,
        ...indexedDbArgs(instance._indexedDb)
      );

      // Wait for the worker to be ready
      await instance.ready;
    } catch (error) {
      // Never handed to the caller, so nothing else would terminate it.
      instance.terminate();
      throw error;
    }

    return createClientProxy(instance);
  }

  /**
   * Factory method to create and initialize a WebClient instance with a remote keystore.
   * This method is async so you can await the asynchronous call to createClientWithExternalKeystore().
   *
   * @param {string} rpcUrl - The RPC URL.
   * @param {string | undefined} noteTransportUrl - The note transport URL (optional).
   * @param {string | undefined} seed - The seed for the account.
   * @param {string | undefined} storeName - Optional name for the store. Setting this allows multiple clients to be used in the same browser.
   * @param {Function | undefined} getKeyCb - The get key callback.
   * @param {Function | undefined} insertKeyCb - The insert key callback.
   * @param {Function | undefined} signCb - The sign callback.
   * @param {string | undefined} logLevel - Optional log verbosity level ("error", "warn", "info", "debug", "trace", "off", or "none").
   * @param {boolean} [useWorker=true] - When `false`, bypass the Web Worker shim
   *   and run WASM calls on the current thread. Required for `CallbackProver`
   *   consumers (the worker path serializes the prover and loses the callback).
   * @returns {Promise<WebClient>} The fully initialized WebClient.
   * @param {{observer?: (observation: object) => void, observeSensitive?: boolean}} [observability]
   *   - Observability fields of `ClientOptions`; see the constructor.
   * @param {string | undefined} [feeFaucetId] - Fee faucet of the chain; see `createClient`.
   * @param {number | undefined} [noteTransportMaxRetries] - Retries of a private note send
   *   after a transient transport failure; see the constructor.
   * @param {number | undefined} [noteTransportRetryIntervalMs] - Delay before the first such
   *   retry; see the constructor.
   */
  static async createClientWithExternalKeystore(
    rpcUrl,
    noteTransportUrl,
    seed,
    storeName,
    getKeyCb,
    insertKeyCb,
    signCb,
    logLevel,
    useWorker = true,
    observability,
    feeFaucetId,
    noteTransportMaxRetries,
    noteTransportRetryIntervalMs,
    indexedDb
  ) {
    // Construct the instance (synchronously).
    const instance = new WebClient(
      rpcUrl,
      noteTransportUrl,
      seed,
      storeName,
      getKeyCb,
      insertKeyCb,
      signCb,
      logLevel,
      useWorker,
      observability,
      feeFaucetId,
      noteTransportMaxRetries,
      noteTransportRetryIntervalMs,
      indexedDb
    );

    try {
      // Set up logging on the main thread before creating the client.
      if (logLevel) {
        const wasm = await getWasmOrThrow();
        wasm.setupLogging(logLevel);
      }

      // Wait for the underlying wasmWebClient to be initialized.
      const wasmWebClient = await instance.getWasmWebClient();
      // Keys the store lock; see `_storeLockId`.
      instance._openedStoreName = (await getWasmOrThrow()).resolveStoreName(
        rpcUrl,
        storeName
      );
      await wasmWebClient.createClientWithExternalKeystore(
        rpcUrl,
        noteTransportUrl,
        seed,
        storeName,
        feeFaucetId,
        getKeyCb,
        insertKeyCb,
        signCb,
        noteTransportMaxRetries,
        noteTransportRetryIntervalMs,
        ...indexedDbArgs(instance._indexedDb)
      );

      await instance.ready;
    } catch (error) {
      // Never handed to the caller, so nothing else would terminate it.
      instance.terminate();
      throw error;
    }
    return createClientProxy(instance);
  }

  /**
   * Call a method via the worker.
   * @param {string} methodName - Name of the method to call.
   * @param  {...any} args - Arguments for the method.
   * @returns {Promise<any>}
   */
  async callMethodWithWorker(methodName, ...args) {
    if (this._terminated) {
      throw new Error("WebClient terminated");
    }
    await this.ready;
    // terminate() can land while this awaits a settled `ready`; the stopped
    // worker would never answer a request posted now.
    if (this._terminated) {
      throw new Error("WebClient terminated");
    }
    // Create a unique request ID.
    const requestId = `${methodName}-${Date.now()}-${Math.random()}`;
    return new Promise((resolve, reject) => {
      // Save the resolve and reject callbacks in the pendingRequests map.
      this.pendingRequests.set(requestId, { resolve, reject });
      // Send the method call request to the worker.
      this.worker.postMessage({
        action: WorkerAction.CALL_METHOD,
        methodName,
        args,
        requestId,
      });
    });
  }

  // ----- Explicitly Wrapped Methods (Worker-Forwarded) -----

  /**
   * Syncs this client if its sync height is still the genesis block, as
   * account creation does first, so the next sync after creating an account
   * does not scan the whole chain. Sync errors are ignored. The sync writes
   * the chain MMR, so on a store still at genesis it requests and waits for
   * the store lock; past genesis it neither syncs nor requests the lock. See
   * `_syncIfAtGenesis`.
   *
   * @returns {Promise<void>}
   */
  async syncBeforeAccountCreation() {
    return this._serializeWasmCall(async () => {
      const wasmWebClient = await this.getWasmWebClient();
      await this._syncIfAtGenesis(wasmWebClient);
    }, "syncBeforeAccountCreation");
  }

  /**
   * Runs the wasm client's `syncBeforeAccountCreation` under the store lock
   * if the store is still at genesis, the only state in which it writes, and
   * otherwise neither requests the lock nor syncs. Called inside the caller's
   * chain slot, it reads the height there without the lock: the height only
   * increases (`importStore` must not run on a store in use), so a store read
   * past genesis stays past it. A failed read takes the genesis path, where
   * the Rust pre-sync reads the height again under the lock and ignores
   * errors.
   *
   * @param {object} wasmWebClient - This instance's wasm client.
   * @returns {Promise<void>}
   * @private
   */
  async _syncIfAtGenesis(wasmWebClient) {
    let atGenesis = true;
    try {
      atGenesis = (await wasmWebClient.getSyncHeight()) === 0;
    } catch {
      // Takes the genesis path.
    }
    if (atGenesis) {
      await runUnderLock(this._storeLockId(), () =>
        wasmWebClient.syncBeforeAccountCreation()
      );
    }
  }

  /**
   * Runs the account creation `method` of the wasm client as one call on this
   * instance's chain, observed under its name. Account creation first syncs a
   * store still at genesis, its only chain write. Inside the call, that sync
   * runs under the store lock (see `_syncIfAtGenesis`), which is released
   * before the creation runs with its own pre-sync skipped, so key
   * generation, the account insert and an external keystore's `insertKey`
   * callback run without it: no application callback runs under the lock.
   * Past genesis the creation neither syncs nor requests the lock. Taking the
   * chain slot first keeps call order, `terminate()` and `waitForIdle()`
   * treating a creation as one call, and its observation includes any lock
   * wait.
   *
   * @param {string} method - The wasm creation method, also the op name.
   * @param {(wasm: object) => any[]} resolveArgs - Its arguments, before the
   *   trailing `skipPreSync`. Resolved before the height read and any
   *   store-lock request, so an argument it checks itself, an unknown auth
   *   scheme or `newFaucet`'s `nonFungible` of `true`, rejects without
   *   syncing. A type error at the wasm boundary (a storage mode, account or
   *   secret key of the wrong type, a `maxSupply` that is not a bigint) still
   *   rejects only after them, and after the locked pre-sync at genesis.
   * @returns {Promise<any>} The result of the creation.
   * @private
   */
  _createAccount(method, resolveArgs) {
    return this._serializeWasmCall(async () => {
      const wasm = await getWasmOrThrow();
      const args = resolveArgs(wasm);
      const wasmWebClient = await this.getWasmWebClient();
      await this._syncIfAtGenesis(wasmWebClient);
      return await wasmWebClient[method](...args, true);
    }, method);
  }

  async newWallet(storageMode, authSchemeId, seed) {
    return this._createAccount("newWallet", (wasm) => [
      storageMode,
      resolveAuthScheme(authSchemeId, wasm),
      seed,
    ]);
  }

  async newFaucet(
    storageMode,
    nonFungible,
    tokenName,
    tokenSymbol,
    decimals,
    maxSupply,
    authSchemeId
  ) {
    return this._createAccount("newFaucet", (wasm) => {
      const authScheme = resolveAuthScheme(authSchemeId, wasm);
      // The wasm newFaucet refuses this before its own pre-sync, with a bare
      // string rather than an Error; this rejects with the same value.
      if (nonFungible === true) {
        throw "Non-fungible faucets are not supported yet";
      }
      return [
        storageMode,
        nonFungible,
        tokenName,
        tokenSymbol,
        decimals,
        maxSupply,
        authScheme,
      ];
    });
  }

  async importPublicAccountFromSeed(seed, authSchemeId) {
    return this._serializeWasmCall(async () => {
      const wasm = await getWasmOrThrow();
      const wasmWebClient = await this.getWasmWebClient();
      return await wasmWebClient.importPublicAccountFromSeed(
        seed,
        resolveAuthScheme(authSchemeId, wasm)
      );
    }, "importPublicAccountFromSeed");
  }

  async newAccount(account, overwrite) {
    return this._createAccount("newAccount", () => [account, overwrite]);
  }

  async newAccountWithSecretKey(account, secretKey) {
    return this._createAccount("newAccountWithSecretKey", () => [
      account,
      secretKey,
    ]);
  }

  async importNoteFile(noteFile) {
    return this._withStoreLock(async () => {
      const wasmWebClient = await this.getWasmWebClient();
      return await wasmWebClient.importNoteFile(noteFile);
    }, "importNoteFile");
  }

  async fetchPrivateNotes() {
    return this._withStoreLock(async () => {
      const wasmWebClient = await this.getWasmWebClient();
      return await wasmWebClient.fetchPrivateNotes();
    }, "fetchPrivateNotes");
  }

  async submitNewTransaction(accountId, transactionRequest) {
    return this._serializeWasmCall(async () => {
      try {
        if (!this.worker) {
          const wasmWebClient = await this.getWasmWebClient();
          return await wasmWebClient.submitNewTransaction(
            accountId,
            transactionRequest
          );
        }

        const wasm = await getWasmOrThrow();
        const serializedTransactionRequest = transactionRequest.serialize();
        const result = await this.callMethodWithWorker(
          MethodName.SUBMIT_NEW_TRANSACTION,
          accountId.toString(),
          serializedTransactionRequest
        );

        const transactionResult = wasm.TransactionResult.deserialize(
          new Uint8Array(result.serializedTransactionResult)
        );

        return transactionResult.id();
      } catch (error) {
        console.error("INDEX.JS: Error in submitNewTransaction:", error);
        throw error;
      }
    }, MethodName.SUBMIT_NEW_TRANSACTION);
  }

  async submitNewTransactionWithProver(accountId, transactionRequest, prover) {
    return this._serializeWasmCall(async () => {
      try {
        if (!this.worker) {
          const wasmWebClient = await this.getWasmWebClient();
          return await wasmWebClient.submitNewTransactionWithProver(
            accountId,
            transactionRequest,
            prover
          );
        }

        const wasm = await getWasmOrThrow();
        const serializedTransactionRequest = transactionRequest.serialize();
        const proverPayload = prover.serialize();
        const result = await this.callMethodWithWorker(
          MethodName.SUBMIT_NEW_TRANSACTION_WITH_PROVER,
          accountId.toString(),
          serializedTransactionRequest,
          proverPayload
        );

        const transactionResult = wasm.TransactionResult.deserialize(
          new Uint8Array(result.serializedTransactionResult)
        );

        return transactionResult.id();
      } catch (error) {
        console.error(
          "INDEX.JS: Error in submitNewTransactionWithProver:",
          error
        );
        throw error;
      }
    }, MethodName.SUBMIT_NEW_TRANSACTION_WITH_PROVER);
  }

  async executeTransaction(accountId, transactionRequest) {
    return this._serializeWasmCall(async () => {
      try {
        if (!this.worker) {
          const wasmWebClient = await this.getWasmWebClient();
          return await wasmWebClient.executeTransaction(
            accountId,
            transactionRequest
          );
        }

        const wasm = await getWasmOrThrow();
        const serializedTransactionRequest = transactionRequest.serialize();
        const serializedResultBytes = await this.callMethodWithWorker(
          MethodName.EXECUTE_TRANSACTION,
          accountId.toString(),
          serializedTransactionRequest
        );

        return wasm.TransactionResult.deserialize(
          new Uint8Array(serializedResultBytes)
        );
      } catch (error) {
        console.error("INDEX.JS: Error in executeTransaction:", error);
        throw error;
      }
    }, MethodName.EXECUTE_TRANSACTION);
  }

  async executeTransactionAt(accountId, transactionRequest, anchor) {
    return this._serializeWasmCall(async () => {
      try {
        // Before the worker branch: on the main-thread path a nullish anchor
        // would otherwise reach wasm and surface as "null pointer passed to
        // rust", which reads like a consumed handle.
        if (!anchor) {
          throw new Error(
            `anchor was ${String(anchor)}; executeTransactionAt requires one — ` +
              "use executeTransaction to execute at the current tip"
          );
        }

        if (!this.worker) {
          const wasmWebClient = await this.getWasmWebClient();
          return await wasmWebClient.executeTransactionAt(
            accountId,
            transactionRequest,
            anchor
          );
        }

        const wasm = await getWasmOrThrow();
        const serializedTransactionRequest = transactionRequest.serialize();
        const serializedAnchor = anchor.serialize();
        const serializedResultBytes = await this.callMethodWithWorker(
          MethodName.EXECUTE_TRANSACTION_AT,
          accountId.toString(),
          serializedTransactionRequest,
          serializedAnchor
        );

        return wasm.TransactionResult.deserialize(
          new Uint8Array(serializedResultBytes)
        );
      } catch (error) {
        console.error("INDEX.JS: Error in executeTransactionAt:", error);
        throw error;
      }
    }, MethodName.EXECUTE_TRANSACTION_AT);
  }

  async proveTransaction(transactionResult, prover) {
    return this._serializeWasmCall(async () => {
      try {
        if (!this.worker) {
          const wasmWebClient = await this.getWasmWebClient();
          return await wasmWebClient.proveTransaction(
            transactionResult,
            prover
          );
        }

        const wasm = await getWasmOrThrow();
        const serializedTransactionResult = transactionResult.serialize();
        const proverPayload = prover ? prover.serialize() : null;

        const serializedProvenBytes = await this.callMethodWithWorker(
          MethodName.PROVE_TRANSACTION,
          serializedTransactionResult,
          proverPayload
        );

        return wasm.ProvenTransaction.deserialize(
          new Uint8Array(serializedProvenBytes)
        );
      } catch (error) {
        console.error("INDEX.JS: Error in proveTransaction:", error);
        throw error;
      }
    }, MethodName.PROVE_TRANSACTION);
  }

  async applyTransaction(transactionResult, submissionHeight) {
    return this._serializeWasmCall(async () => {
      try {
        if (!this.worker) {
          const wasmWebClient = await this.getWasmWebClient();
          return await wasmWebClient.applyTransaction(
            transactionResult,
            submissionHeight
          );
        }

        const wasm = await getWasmOrThrow();
        const serializedTransactionResult = transactionResult.serialize();
        const serializedUpdateBytes = await this.callMethodWithWorker(
          MethodName.APPLY_TRANSACTION,
          serializedTransactionResult,
          submissionHeight
        );

        return wasm.TransactionStoreUpdate.deserialize(
          new Uint8Array(serializedUpdateBytes)
        );
      } catch (error) {
        console.error("INDEX.JS: Error in applyTransaction:", error);
        throw error;
      }
    }, MethodName.APPLY_TRANSACTION);
  }

  /**
   * Syncs the client (NTL followed by chain sync, failing fast on either).
   *
   * This method coordinates concurrent sync calls using the Web Locks API when available,
   * with an in-process mutex fallback for older browsers. A call made while this client's
   * run of it is pending waits for that run and receives the same result (coalescing
   * behavior), unless another call has been queued on this client since the run was made:
   * then it runs its own sync, behind that call. A sync on another client on the same store
   * never shares it: it runs its own sync, serialized with this one by the store lock.
   *
   * @returns {Promise<SyncSummary>} The sync summary
   */
  async syncState() {
    const methodId = MethodName.SYNC_STATE;

    try {
      // A call joins this client's pending run of this sync only while no
      // other call has been queued on the client since; see `_withStoreLock`.
      return await this._withStoreLock(
        async () => {
          if (!this.worker) {
            const wasmWebClient = await this.getWasmWebClient();
            return await wasmWebClient.syncStateImpl();
          }
          const wasm = await getWasmOrThrow();
          const serializedSyncSummaryBytes =
            await this.callMethodWithWorker(methodId);
          return wasm.SyncSummary.deserialize(
            new Uint8Array(serializedSyncSummaryBytes)
          );
        },
        methodId,
        methodId
      );
    } catch (error) {
      console.error("INDEX.JS: Error in syncState:", error);
      throw error;
    }
  }

  /**
   * Fetches private notes from the Note Transport Layer.
   *
   * @returns {Promise<void>}
   */
  async syncNoteTransport() {
    const methodId = MethodName.SYNC_NOTE_TRANSPORT;

    try {
      await this._withStoreLock(
        async () => {
          if (!this.worker) {
            const wasmWebClient = await this.getWasmWebClient();
            await wasmWebClient.syncNoteTransportImpl();
          } else {
            await this.callMethodWithWorker(methodId);
          }
        },
        methodId,
        methodId
      );
    } catch (error) {
      console.error("INDEX.JS: Error in syncNoteTransport:", error);
      throw error;
    }
  }

  /**
   * Syncs on-chain state only (no NTL fetch).
   *
   * @returns {Promise<SyncSummary>}
   */
  async syncChain() {
    const methodId = MethodName.SYNC_CHAIN;

    try {
      return await this._withStoreLock(
        async () => {
          if (!this.worker) {
            const wasmWebClient = await this.getWasmWebClient();
            return await wasmWebClient.syncChainImpl();
          }
          const wasm = await getWasmOrThrow();
          const serializedSyncSummaryBytes =
            await this.callMethodWithWorker(methodId);
          return wasm.SyncSummary.deserialize(
            new Uint8Array(serializedSyncSummaryBytes)
          );
        },
        methodId,
        methodId
      );
    } catch (error) {
      console.error("INDEX.JS: Error in syncChain:", error);
      throw error;
    }
  }

  /**
   * Terminates this WebClient: stops its Web Worker if there is one, and
   * releases the main-realm wasm client and, through it, its IndexedDB store
   * connection, which closes once no other client in this realm holds the
   * same store.
   *
   * Call this method when you're done using a WebClient to free up browser
   * resources. A call already queued or running that executes against the
   * main-realm wasm client still finishes, one that waits for the store lock
   * first included (see `_withStoreLock`). A call that needs the worker,
   * whether in flight, waiting for the worker to be ready or still queued
   * behind terminate(), rejects with "WebClient terminated". Every wasm call
   * made after terminate() fails with it too: a synchronous member or an
   * accessor throws, every other member rejects. The release waits until all
   * of these calls have settled. Calling it again is harmless.
   *
   * The release and the rejections are browser-only: on the Node.js binding
   * WasmWebClient.terminate() is a no-op.
   */
  terminate() {
    this._terminated = true;
    if (this.worker) {
      this.worker.terminate();
      // The stopped worker answers nothing, so a call still waiting on it
      // would hold the call chain, and the release queued behind it, forever.
      this.readyRejecter(new Error("WebClient terminated"));
      for (const { reject } of this.pendingRequests.values()) {
        reject(new Error("WebClient terminated"));
      }
      this.pendingRequests.clear();
    }
    this._afterQueuedWasmCalls(async () => {
      this._releaseStorageCallback?.();
      const client = this.wasmWebClient;
      this.wasmWebClient = null;
      this.wasmWebClientPromise = null;
      if (!client) {
        return;
      }
      this._freedWasmPrototype = Object.getPrototypeOf(client);
      await this._freeWasmClient(client, "terminate");
    });
  }

  /**
   * Frees a detached wasm client once every tracked raw-bound call has
   * settled: those calls borrow it off the call chain, and free() refuses a
   * borrowed client. A free() that still throws is reported, not rethrown.
   * It never joins the call chain, so a step on the chain can await it.
   * @private
   */
  async _freeWasmClient(client, occasion) {
    await Promise.allSettled(this._rawWasmCalls ?? []);
    try {
      client.free();
    } catch (error) {
      console.error(
        `WebClient: failed to free the wasm client on ${occasion}:`,
        error
      );
    }
  }

  /**
   * Runs `step` once every serialized call already on `_wasmCallChain` has
   * settled, so a wasm client is never freed under a call still using it.
   * `step` is not counted in `_queuedCalls`, so it ends no sync run's joining
   * window: a sync called after terminate() is refused by `_withStoreLock`.
   * @private
   */
  _afterQueuedWasmCalls(step) {
    this._wasmCallChain = this._wasmCallChain.then(step).catch(() => {});
  }

  /**
   * Tracks a raw-bound call that returned a promise until it settles. It
   * borrows the wasm client off the call chain, so `_freeWasmClient` waits
   * for it as well.
   * @private
   */
  _trackRawWasmCall(promise) {
    if (!this._rawWasmCalls) {
      this._rawWasmCalls = new Set();
    }
    const calls = this._rawWasmCalls;
    const tracked = Promise.resolve(promise).then(
      () => calls.delete(tracked),
      () => calls.delete(tracked)
    );
    calls.add(tracked);
  }
}

class MockWebClient extends WebClient {
  constructor(seed, logLevel, indexedDb, useWorker = true) {
    super(
      null,
      null,
      seed,
      MOCK_STORE_NAME,
      undefined,
      undefined,
      undefined,
      logLevel,
      useWorker,
      undefined,
      undefined,
      undefined,
      undefined,
      indexedDb
    );
  }

  initializeWorker() {
    // Pass `numThreads` exactly like the real INIT path: every prove runs
    // inside the worker's own WASM instance, and rayon's pool is
    // per-instance — without this, mock-client proving (including the
    // integration suite) silently runs single-threaded.
    let numThreads = 1;
    try {
      if (
        typeof self !== "undefined" &&
        self.crossOriginIsolated &&
        navigator?.hardwareConcurrency
      ) {
        numThreads = navigator.hardwareConcurrency;
      }
    } catch {}
    this.worker.postMessage({
      action: WorkerAction.INIT_MOCK,
      args: [
        this.seed,
        this.logLevel,
        numThreads,
        ...indexedDbArgs(workerIndexedDbOptions(this._indexedDb)),
      ],
    });
  }

  /**
   * Factory method to create a WebClient with a mock chain for testing purposes.
   *
   * @param serializedMockChain - Serialized mock chain data (optional). Will use an empty chain if not provided.
   * @param serializedMockNoteTransportNode - Serialized mock note transport node data (optional). Will use a new instance if not provided.
   * @param seed - The seed for the account (optional).
   * @returns A promise that resolves to a MockWebClient.
   */
  static async createClient(
    serializedMockChain,
    serializedMockNoteTransportNode,
    seed,
    logLevel,
    indexedDb,
    useWorker
  ) {
    // Construct the instance (synchronously).
    const instance = new MockWebClient(seed, logLevel, indexedDb, useWorker);

    try {
      // Set up logging on the main thread before creating the client.
      if (logLevel) {
        const wasm = await getWasmOrThrow();
        wasm.setupLogging(logLevel);
      }

      // Wait for the underlying wasmWebClient to be initialized.
      const wasmWebClient = await instance.getWasmWebClient();
      await wasmWebClient.createMockClient(
        seed ?? null,
        serializedMockChain ?? null,
        serializedMockNoteTransportNode ?? null,
        ...indexedDbArgs(instance._indexedDb)
      );

      // Wait for the worker to be ready
      await instance.ready;
    } catch (error) {
      // Never handed to the caller, so nothing else would terminate it.
      instance.terminate();
      throw error;
    }

    return createClientProxy(instance);
  }

  /**
   * Syncs the mock client state.
   *
   * This method coordinates concurrent sync calls using the Web Locks API when available,
   * with an in-process mutex fallback for older browsers. A call made while this client's
   * run of it is pending waits for that run and receives the same result (coalescing
   * behavior), unless another call has been queued on this client since the run was made:
   * then it runs its own sync, behind that call. A sync on another client on the same store
   * never shares it: it runs its own sync, serialized with this one by the store lock.
   *
   * @returns {Promise<SyncSummary>} The sync summary
   */
  async syncState() {
    const methodId = MethodName.SYNC_STATE;

    try {
      return await this._withStoreLock(
        async () => {
          const wasmWebClient = await this.getWasmWebClient();

          if (!this.worker) {
            return await wasmWebClient.syncStateImpl();
          }

          const serializedMockChain = (await wasmWebClient.serializeMockChain())
            .buffer;
          const serializedMockNoteTransportNode = (
            await wasmWebClient.serializeMockNoteTransportNode()
          ).buffer;

          const wasm = await getWasmOrThrow();
          const serializedSyncSummaryBytes = await this.callMethodWithWorker(
            MethodName.SYNC_STATE_MOCK,
            serializedMockChain,
            serializedMockNoteTransportNode
          );
          return wasm.SyncSummary.deserialize(
            new Uint8Array(serializedSyncSummaryBytes)
          );
        },
        undefined,
        methodId
      );
    } catch (error) {
      console.error("INDEX.JS: Error in syncState:", error);
      throw error;
    }
  }

  /**
   * Syncs only the on-chain mock state (no note transport fetch).
   *
   * In worker mode, the main-thread mock chain + note-transport-node state
   * is serialized and shipped to the worker before the sync, so a prior
   * `proveBlock()` on the main thread is reflected in the worker's WASM
   * client. The no-worker path uses the main-thread WASM client directly.
   *
   * @returns {Promise<SyncSummary>}
   */
  async syncChain() {
    const methodId = MethodName.SYNC_CHAIN;

    try {
      return await this._withStoreLock(
        async () => {
          const wasmWebClient = await this.getWasmWebClient();

          if (!this.worker) {
            return await wasmWebClient.syncChainImpl();
          }

          const serializedMockChain = (await wasmWebClient.serializeMockChain())
            .buffer;
          const serializedMockNoteTransportNode = (
            await wasmWebClient.serializeMockNoteTransportNode()
          ).buffer;

          const wasm = await getWasmOrThrow();
          const serializedSyncSummaryBytes = await this.callMethodWithWorker(
            MethodName.SYNC_CHAIN_MOCK,
            serializedMockChain,
            serializedMockNoteTransportNode
          );
          return wasm.SyncSummary.deserialize(
            new Uint8Array(serializedSyncSummaryBytes)
          );
        },
        undefined,
        methodId
      );
    } catch (error) {
      console.error("INDEX.JS: Error in syncChain:", error);
      throw error;
    }
  }

  /**
   * Syncs only the mock note-transport state (no chain fetch).
   *
   * Mirrors {@link MockWebClient#syncChain}: in worker mode, the
   * main-thread mock chain + note-transport-node state is serialized
   * and shipped to the worker first.
   *
   * @returns {Promise<void>}
   */
  async syncNoteTransport() {
    const methodId = MethodName.SYNC_NOTE_TRANSPORT;

    try {
      await this._withStoreLock(
        async () => {
          const wasmWebClient = await this.getWasmWebClient();

          if (!this.worker) {
            await wasmWebClient.syncNoteTransportImpl();
            return;
          }

          const serializedMockChain = (await wasmWebClient.serializeMockChain())
            .buffer;
          const serializedMockNoteTransportNode = (
            await wasmWebClient.serializeMockNoteTransportNode()
          ).buffer;

          await this.callMethodWithWorker(
            MethodName.SYNC_NOTE_TRANSPORT_MOCK,
            serializedMockChain,
            serializedMockNoteTransportNode
          );
        },
        undefined,
        methodId
      );
    } catch (error) {
      console.error("INDEX.JS: Error in syncNoteTransport:", error);
      throw error;
    }
  }

  async submitNewTransaction(accountId, transactionRequest) {
    try {
      if (!this.worker) {
        return await super.submitNewTransaction(accountId, transactionRequest);
      }

      return await this._serializeWasmCall(async () => {
        const wasmWebClient = await this.getWasmWebClient();
        const wasm = await getWasmOrThrow();
        const serializedTransactionRequest = transactionRequest.serialize();
        const serializedMockChain = (await wasmWebClient.serializeMockChain())
          .buffer;
        const serializedMockNoteTransportNode = (
          await wasmWebClient.serializeMockNoteTransportNode()
        ).buffer;

        const result = await this.callMethodWithWorker(
          MethodName.SUBMIT_NEW_TRANSACTION_MOCK,
          accountId.toString(),
          serializedTransactionRequest,
          serializedMockChain,
          serializedMockNoteTransportNode
        );

        const newMockChain = new Uint8Array(result.serializedMockChain);
        const newMockNoteTransportNode = result.serializedMockNoteTransportNode
          ? new Uint8Array(result.serializedMockNoteTransportNode)
          : undefined;

        const transactionResult = wasm.TransactionResult.deserialize(
          new Uint8Array(result.serializedTransactionResult)
        );

        if (!(this instanceof MockWebClient)) {
          return transactionResult.id();
        }

        // Attached only once it is built, so a failed build leaves the
        // replaced client in place.
        const replacement = new wasm.WebClient();
        try {
          await replacement.createMockClient(
            this.seed,
            newMockChain,
            newMockNoteTransportNode,
            ...indexedDbArgs(this._indexedDb)
          );
        } catch (error) {
          try {
            replacement.free();
          } catch {
            // Nothing references it.
          }
          throw error;
        }
        this.wasmWebClient = replacement;
        this.wasmWebClientPromise = Promise.resolve(replacement);
        await this._freeWasmClient(wasmWebClient, "replacement");

        return transactionResult.id();
      });
    } catch (error) {
      console.error("INDEX.JS: Error in submitNewTransaction:", error);
      throw error;
    }
  }

  async submitNewTransactionWithProver(accountId, transactionRequest, prover) {
    try {
      if (!this.worker) {
        return await super.submitNewTransactionWithProver(
          accountId,
          transactionRequest,
          prover
        );
      }

      return await this._serializeWasmCall(async () => {
        const wasmWebClient = await this.getWasmWebClient();
        const wasm = await getWasmOrThrow();
        const serializedTransactionRequest = transactionRequest.serialize();
        const proverPayload = prover.serialize();
        const serializedMockChain = (await wasmWebClient.serializeMockChain())
          .buffer;
        const serializedMockNoteTransportNode = (
          await wasmWebClient.serializeMockNoteTransportNode()
        ).buffer;

        const result = await this.callMethodWithWorker(
          MethodName.SUBMIT_NEW_TRANSACTION_WITH_PROVER_MOCK,
          accountId.toString(),
          serializedTransactionRequest,
          proverPayload,
          serializedMockChain,
          serializedMockNoteTransportNode
        );

        const newMockChain = new Uint8Array(result.serializedMockChain);
        const newMockNoteTransportNode = result.serializedMockNoteTransportNode
          ? new Uint8Array(result.serializedMockNoteTransportNode)
          : undefined;

        const transactionResult = wasm.TransactionResult.deserialize(
          new Uint8Array(result.serializedTransactionResult)
        );

        if (!(this instanceof MockWebClient)) {
          return transactionResult.id();
        }

        // Attached only once it is built, so a failed build leaves the
        // replaced client in place.
        const replacement = new wasm.WebClient();
        try {
          await replacement.createMockClient(
            this.seed,
            newMockChain,
            newMockNoteTransportNode,
            ...indexedDbArgs(this._indexedDb)
          );
        } catch (error) {
          try {
            replacement.free();
          } catch {
            // Nothing references it.
          }
          throw error;
        }
        this.wasmWebClient = replacement;
        this.wasmWebClientPromise = Promise.resolve(replacement);
        await this._freeWasmClient(wasmWebClient, "replacement");

        return transactionResult.id();
      });
    } catch (error) {
      console.error(
        "INDEX.JS: Error in submitNewTransactionWithProver:",
        error
      );
      throw error;
    }
  }
}

function copyWebClientStatics(WasmWebClient) {
  if (!WasmWebClient) {
    return;
  }
  Object.getOwnPropertyNames(WasmWebClient).forEach((prop) => {
    if (
      typeof WasmWebClient[prop] === "function" &&
      prop !== "constructor" &&
      prop !== "prototype"
    ) {
      WebClient[prop] = WasmWebClient[prop];
    }
  });
}

// Wire MidenClient dependencies (resolves circular import)
MidenClient._WasmWebClient = WebClient;
MidenClient._MockWasmWebClient = MockWebClient;
MidenClient._getWasmOrThrow = getWasmOrThrow;
_setStandaloneWebClient(WebClient);

/**
 * @internal Test-only seam. Exercises `_serializeWasmCall`'s observation
 * contract without constructing a real WASM-backed client. The host carries
 * the flag exactly as the constructor would have sealed it — a normalized
 * boolean — because `_serializeWasmCall` takes no per-call override.
 */
export function __serializeWasmCallForTest(fn, opName, observabilityConfig) {
  const host = {
    _withInnerLockDepth: 0,
    _wasmCallChain: Promise.resolve(),
    _queuedCalls: 0,
    _observeSensitive: observabilityConfig?.observeSensitive === true,
    _serializeWasmCall: WebClient.prototype._serializeWasmCall,
  };
  return host._serializeWasmCall(fn, opName);
}

/**
 * @internal Test-only seam. `createClientProxy` is module-private, and its
 * raw-bind branch for `SYNC_METHODS` is only observable through the proxy.
 */
export function __createClientProxyForTest(instance) {
  return createClientProxy(instance);
}

/** @internal Test-only seam for `applyObserverOptions`. */
export function __applyObserverOptionsForTest(options) {
  return applyObserverOptions(options);
}

/**
 * @internal Test-only seam. The high-fidelity warning fires once per process,
 * so a test asserting that has to be able to return to a fresh process state.
 */
export function __resetSensitiveWarningForTest() {
  sensitiveWarningEmitted = false;
}
