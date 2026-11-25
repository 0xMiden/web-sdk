import loadWasm, { resolveWasmUrl } from "./wasm.js";
import { CallbackType, MethodName, WorkerAction } from "./constants.js";
import {
  coalesceRun,
  lockWaitError,
  LOCK_WAIT_TIMEOUT_MS,
  runUnderLock,
  withSyncLock,
} from "./syncLock.js";
import {
  appendAuthError,
  serializeCallbackError,
  validateCallbackTimeoutMs,
} from "./callbackBridge.js";
import { emitObservation, hasObserver, setObserver } from "./observability.js";
import { assertBatchItems } from "./utils.js";
import { MidenClient } from "./client.js";
import { CompilerResource } from "./resources/compiler.js";
import { claimStore, validateNoteTransportRetryOptions } from "./utils.js";
import {
  createP2IDNote,
  createP2IDENote,
  createFeeSponsorshipNote,
  buildSwapTag,
  buildNetworkNote,
  isStandardPayment,
  domainSeparatedSignCommitment,
  _setWasm as _setStandaloneWasm,
  _setWebClient as _setStandaloneWebClient,
} from "./standalone.js";
import {
  installStorageView,
  StorageView,
  StorageResult,
  wordToBigInt,
} from "./storageView.js";
import {
  installAuthSchemeResolution,
  resolveAuthScheme,
  wrapAuthGuardedMultisigConfig,
} from "./utils.js";
import {
  AuthGuardedMultisigConfig as WasmAuthGuardedMultisigConfig,
  AuthScheme as WasmAuthScheme,
} from "../Cargo.toml";
export * from "../Cargo.toml";

// The package's `AuthScheme` (below) is the friendly string const and shadows
// the wasm enum, so these bindings resolve the friendly strings themselves.
// AccountComponent.createAuthComponentFromCommitment is patched once the wasm
// module loads (see ensureWasm).
export const AuthGuardedMultisigConfig = wrapAuthGuardedMultisigConfig(
  () => WasmAuthGuardedMultisigConfig,
  () => ({ AuthScheme: WasmAuthScheme })
);

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
export {
  createP2IDNote,
  createP2IDENote,
  createFeeSponsorshipNote,
  buildSwapTag,
  buildNetworkNote,
  isStandardPayment,
  domainSeparatedSignCommitment,
};
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
//     The methods that read the store while holding the borrow — the nine
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
  "endpoint",
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
  "importWatchedAccountById",
  "insertAccountAddress",
  "newAccount",
  "newB2AggTransactionRequest",
  "newConsumeTransactionRequest",
  "newMintTransactionRequest",
  "newPswapCancelTransactionRequest",
  "newPswapConsumeTransactionRequest",
  "newPswapCreateTransactionRequest",
  "newRegisterNoteScriptsTransactionRequest",
  "newSendTransactionRequest",
  "newSwapTransactionRequest",
  "newXReserveBurnTransactionRequest",
  "pruneAccountHistory",
  "registerAccount",
  "removeAccountAddress",
  "removeTag",
  "removeSetting",
  "sendPrivateNote",
  "sendPrivateOutputNote",
  "setSetting",
  "submitProvenTransaction",
  "trackAccountWitness",
  "untrackAccountWitness",
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
  "getNoteConsumability",
  "getNoteConsumabilityForAccount",
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
  "protocolConfig",
  "storeIdentifier",
  "trackedAccountWitnesses",
]);

// Only reads with an independently verified committed snapshot may pass a worker turn.
const LOCAL_SNAPSHOT_READS = new Set(["getSyncHeight"]);

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
        installAuthSchemeResolution(module.AccountComponent, module);
        if (module.AuthGuardedMultisigConfig) {
          AuthGuardedMultisigConfig.prototype =
            module.AuthGuardedMultisigConfig.prototype;
        }
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

/**
 * Error detail for one failed observation. Undefined unless `enabled` is
 * true, so the caller can leave `sensitive` off the object entirely.
 *
 * @param {boolean} enabled
 * @param {unknown} error
 * @returns {{ errorMessage: string, errorStack?: string } | undefined}
 */
function observationSensitive(enabled, error) {
  if (enabled !== true) return undefined;
  return {
    errorMessage: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack
      ? { errorStack: error.stack }
      : {}),
  };
}

// Marks the trusted handle `_withInnerWebClient` passes its callback: a call
// whose receiver reads it as true runs inline in that callback's chain slot.
const TRUSTED_CALLS = Symbol("trustedWasmCalls");

/**
 * A view of `client` for `_withInnerWebClient`. Every method reached through it
 * runs with the view as `this`, so only calls made through the view, and the
 * calls those make on `this`, skip the queue. After `release()` a kept view
 * queues like the client itself.
 * @internal
 */
function createTrustedHandle(client) {
  let active = true;
  const handle = new Proxy(client, {
    get(target, prop, receiver) {
      return prop === TRUSTED_CALLS
        ? active
        : Reflect.get(target, prop, receiver);
    },
  });
  return { handle, release: () => (active = false) };
}

function createClientProxy(instance) {
  return new Proxy(instance, {
    get(target, prop, receiver) {
      // Only a trusted handle answers true; it intercepts the read itself.
      if (prop === TRUSTED_CALLS) {
        return false;
      }
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      const live = target.wasmWebClient;
      // After terminate() only a read through an in-flight
      // `_withInnerWebClient` handle keeps the live route, as in
      // `_serializeWasmCall`: it belongs to work queued before terminate() ran.
      const liveRoute =
        live && (!target._terminated || receiver[TRUSTED_CALLS] === true);
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
            receiver._serializeWasmCall(
              () => value.apply(target.wasmWebClient, args),
              prop,
              undefined,
              { localRead: LOCAL_SNAPSHOT_READS.has(prop) }
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
   * @param {string | undefined} [feeFaucetId] - Deprecated. Faucet of the chain's
   *   fee asset, as a bech32 address or a hex account ID. Not needed: creating the
   *   client stores the protocol configuration, which names the fee asset.
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
   * @param {number | undefined} [callbackTimeoutMs] - The `callbackTimeoutMs`
   *   field of `ClientOptions`: how long the Web Worker waits for each external
   *   keystore callback. See `callbackTimeoutFor` in `callbackBridge.js`.
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
    callbackTimeoutMs
  ) {
    validateNoteTransportRetryOptions(
      noteTransportMaxRetries,
      noteTransportRetryIntervalMs
    );
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
    this._callbackTimeoutMs = validateCallbackTimeoutMs(callbackTimeoutMs);
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
              callbackOk: true,
              callbackResult: result,
              callbackRequestId: requestId,
            });
          } catch (error) {
            // A callback may throw any value, including one with no `.message`
            // (a string, `{ code: 4001 }`, `null`), so send an explicit failure
            // flag and the cloneable fields the worker needs to rebuild the
            // error, including when causes cycle or properties are unreadable.
            const reply = {
              callbackOk: false,
              callbackError: serializeCallbackError(error, callbackType),
              callbackRequestId: requestId,
            };
            try {
              this.worker.postMessage(reply);
            } catch {
              this.worker.postMessage({
                callbackOk: false,
                callbackError: {
                  message: `${callbackType} callback threw an unreadable value`,
                },
                callbackRequestId: requestId,
              });
            }
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

      // A script that fails to load or throws uncaught, or a message that
      // cannot be deserialized, leaves the worker unable to answer; without
      // these listeners every call waits on it forever.
      this.worker.addEventListener("error", (event) => {
        this._failWorker(event?.message || "the worker script failed to run");
      });
      this.worker.addEventListener("messageerror", () => {
        this._failWorker("the worker sent a message that could not be read");
      });

      // Once the worker script has loaded, initialize the worker. Classic
      // init is async (resolves the WASM URL on this thread first — #286).
      this.loaded.then(() => {
        Promise.resolve(this.initializeWorker()).catch((error) => {
          this.readyRejecter(error);
        });
      });
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
    this._orderedCalls = 0;
    this._workerOnlyTurn = null;
    this._localReadTail = Promise.resolve();
    this._activeLocalReads = new Set();
    // This client's in-flight coalesced syncs; see `_withStoreLock`.
    this._syncRuns = new Map();
    // A coalesced sync run stops accepting joiners when another call is made.
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
   * Orders both direct and worker calls. A snapshot-safe local read may pass
   * an active worker-only turn if no later ordered call is already queued.
   *
   * Re-entrancy: a call made through the trusted handle an in-flight
   * `_withInnerWebClient(fn)` passes `fn` (see `createTrustedHandle`) runs
   * inline. The outer call already holds the chain slot, so queueing the
   * inner call would deadlock. Every other caller, including one that runs
   * during an await inside `fn`, queues behind that slot.
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
   * @param {{ emitted: boolean }} [gate] - Set when a store-locked deadline
   *   already emitted this call's observation, so this turn does not emit
   *   again. Other callers omit it.
   * @param {{ workerOnly?: boolean, localRead?: boolean }} [options]
   * @returns {Promise<any>} The result of fn.
   */
  _serializeWasmCall(fn, opName, gate, { workerOnly, localRead } = {}) {
    // A call through an in-flight `_withInnerWebClient` handle still runs
    // inline: it belongs to work that was already queued when terminate() ran.
    const trusted = this[TRUSTED_CALLS] === true;
    if (this._terminated && !trusted) {
      return Promise.reject(new Error("WebClient terminated"));
    }
    // Opt-in twice over: with no op name or nobody listening, `fn` is
    // enqueued exactly as before and no timing work is done at all.
    const observed = opName !== undefined && hasObserver();
    const wrapped = observed
      ? async () => {
          // The deadline already reported this call. The skipped turn still
          // runs, with no clock and no second observation.
          if (gate?.emitted) {
            return fn();
          }
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
            const sensitive = observationSensitive(
              this._observeSensitive,
              error
            );
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

    if (trusted) {
      return Promise.resolve().then(wrapped);
    }
    this._queuedCalls += 1;
    if (
      localRead &&
      this.worker &&
      !this._workerFailure &&
      this.wasmWebClient &&
      this._workerOnlyTurn?.orderedSeq === this._orderedCalls
    ) {
      return this._runLocalRead(wrapped);
    }

    const orderedSeq = (this._orderedCalls ?? 0) + 1;
    this._orderedCalls = orderedSeq;
    const result = this._wasmCallChain
      .catch(() => {})
      .then(async () => {
        if (
          workerOnly &&
          this.worker &&
          !this._workerFailure &&
          !this._terminated
        ) {
          this._workerOnlyTurn = { orderedSeq };
          try {
            return await wrapped();
          } finally {
            this._workerOnlyTurn = null;
          }
        }
        if (this._activeLocalReads?.size) {
          await Promise.allSettled(this._activeLocalReads);
        }
        return wrapped();
      });
    this._wasmCallChain = result.catch(() => {});
    return result;
  }

  /**
   * A main-realm WASM borrow must exclude both other reads and ordered calls.
   * @private
   */
  _runLocalRead(fn) {
    const reads = this._activeLocalReads;
    const read = this._localReadTail.then(fn).finally(() => reads.delete(read));
    reads.add(read);
    this._localReadTail = read.catch(() => {});
    return read;
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
   * Lock order is always call chain, then store lock. The budget starts when
   * the store-locked call is made and covers the chain and then the lock: the
   * call takes its chain slot when it is made, like any other call, and
   * requests the lock when that slot starts, with the time still left. The
   * deadline rejection emits the one error observation then, with `durationMs`
   * 0, the skipped turn emits nothing, and a turn that reaches the lock still
   * observes the lock wait from the turn. So call order, `terminate()` and
   * `waitForIdle()` treat it like any other call, and a lock holder never
   * waits for a callback of its own instance. A call waiting for another
   * instance's holder holds this instance's chain meanwhile, and its
   * observation, named by `opName`, includes that wait.
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
   * Made through a `_withInnerWebClient` handle, the call runs inline like any
   * call through it and requests the lock itself. It never joins a coalesced run, which may
   * be queued behind the callback.
   *
   * @param {() => Promise<any>} fn - The WASM work.
   * @param {string} [opName] - Operation name, as for `_serializeWasmCall`.
   * @param {string} [syncMethod] - The sync method to coalesce under.
   * @param {{ workerOnly?: boolean }} [options] - A worker-only body can
   *   allow eligible local reads during its ordered turn.
   * @returns {Promise<any>} The result of fn.
   * @private
   */
  _withStoreLock(fn, opName, syncMethod, options) {
    // `_serializeWasmCall` rejects too, but a joiner never reaches it.
    // The terminated check arms nothing.
    if (this._terminated && this[TRUSTED_CALLS] !== true) {
      return Promise.reject(new Error("WebClient terminated"));
    }
    const dbId = this._storeLockId();
    const workerOnly = options?.workerOnly === true && !!this.worker;
    // Both branches call `run`: a store-locked call without `syncMethod`
    // (importNoteFile, fetchPrivateNotes) or nested in `_withInnerWebClient`,
    // and `coalesceRun`'s start for a sync. A joiner shares that promise and
    // gets no timer of its own.
    const run = () => {
      const startedAt = Date.now();
      let timedOut = false;
      let timeoutError;
      let resolveCaller = () => {};
      let rejectCaller = () => {};
      const caller = new Promise((resolve, reject) => {
        resolveCaller = resolve;
        rejectCaller = reject;
      });
      const fail = () => {
        if (!timeoutError) {
          timeoutError = lockWaitError(dbId, LOCK_WAIT_TIMEOUT_MS);
        }
        return timeoutError;
      };
      // Taken when the call is made. A joiner never reaches `run`, and a
      // listener registered later is not this call's observer.
      const observe = opName !== undefined && hasObserver();
      const gate = observe ? { emitted: false } : undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        if (observe) {
          gate.emitted = true;
        }
        const error = fail();
        rejectCaller(error);
        if (observe) {
          const sensitive = observationSensitive(this._observeSensitive, error);
          emitObservation({
            op: opName,
            outcome: "error",
            durationMs: 0,
            ...(sensitive !== undefined ? { sensitive } : {}),
          });
        }
      }, LOCK_WAIT_TIMEOUT_MS);
      const chain = this._serializeWasmCall(
        () => {
          const remaining = LOCK_WAIT_TIMEOUT_MS - (Date.now() - startedAt);
          if (timedOut || remaining <= 0) {
            clearTimeout(timer);
            // The chain catch already attached swallows this late throw.
            throw fail();
          }
          clearTimeout(timer);
          return runUnderLock(dbId, fn, remaining);
        },
        opName,
        gate,
        { workerOnly }
      );
      chain.then(
        (value) => {
          clearTimeout(timer);
          resolveCaller(value);
        },
        (error) => {
          clearTimeout(timer);
          rejectCaller(error);
        }
      );
      return caller;
    };
    if (!syncMethod || this[TRUSTED_CALLS] === true) {
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
   * Waits for the ordered calls and concurrent reads already queued.
   * @returns {Promise<void>}
   */
  async waitForIdle() {
    await Promise.allSettled([
      this._wasmCallChain,
      ...(this._activeLocalReads ?? []),
    ]);
  }

  // TODO: This will soon conflict with some changes in main.
  // More context here:
  // https://github.com/0xMiden/miden-client/pull/1645?notification_referrer_id=NT_kwHOA1yg7NoAJVJlcG9zaXRvcnk7NjU5MzQzNzAyO0lzc3VlOzM3OTY4OTU1Nzk&notifications_query=is%3Aunread#discussion_r2696075480
  async initializeWorker() {
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
    // Classic worker: resolve the hashed WASM URL here. The classic build
    // rewrites import.meta.url → self.location.href inside the worker, so the
    // worker cannot trace the bundler's emitted asset itself (#286).
    let wasmUrl;
    if (WebClient._shouldUseClassicWorker()) {
      wasmUrl = await resolveWasmUrl();
    }
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
        this._callbackTimeoutMs,
        wasmUrl,
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
   * @param {string | undefined} feeFaucetId - Deprecated. Fee faucet of the chain, as a bech32
   *   address or a hex account ID. Not needed: creating the client stores the protocol
   *   configuration, which names the fee asset.
   * @param {number | undefined} [noteTransportMaxRetries] - Retries of a private note send
   *   after a transient transport failure; see the constructor.
   * @param {number | undefined} [noteTransportRetryIntervalMs] - Delay before the first such
   *   retry; see the constructor.
   * @param {number | undefined} [callbackTimeoutMs] - How long to wait for external keystore
   *   callbacks. Invalid values reject before WASM initialization.
   * @param {boolean} [exclusive=false] - Refuse a store another live client has open, and make
   *   every other open of this store refuse until this client terminates. Without it, opening
   *   an open store warns naming the client that has it.
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
    callbackTimeoutMs,
    exclusive = false
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
      callbackTimeoutMs
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
      instance._releaseStore = claimStore(instance._openedStoreName, exclusive);
      await wasmWebClient.createClient(
        rpcUrl,
        noteTransportUrl,
        seed,
        network,
        feeFaucetId,
        noteTransportMaxRetries,
        noteTransportRetryIntervalMs
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
   * @param {number | undefined} [callbackTimeoutMs] - See the constructor.
   * @param {boolean} [exclusive=false] - See `createClient`.
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
    callbackTimeoutMs,
    exclusive = false
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
      callbackTimeoutMs
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
      instance._releaseStore = claimStore(instance._openedStoreName, exclusive);
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
        noteTransportRetryIntervalMs
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
    if (this._workerFailure) {
      throw this._workerFailure;
    }
    await this.ready;
    // terminate() can land while this awaits a settled `ready`; the stopped
    // worker would never answer a request posted now.
    if (this._terminated) {
      throw new Error("WebClient terminated");
    }
    // The worker can also fail after `ready` settled.
    if (this._workerFailure) {
      throw this._workerFailure;
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
          try {
            return await wasmWebClient.submitNewTransaction(
              accountId,
              transactionRequest
            );
          } catch (error) {
            const authError = wasmWebClient.lastAuthError();
            if (typeof error === "string")
              throw appendAuthError(error, authError);
            if (error instanceof Error) {
              error.message = appendAuthError(error.message, authError);
            }
            throw error;
          }
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

  /**
   * Submits transaction requests, each paired with its executing account, as
   * one atomic batch.
   *
   * Every transaction is executed and proven, and the batch proof produced,
   * inside a single WASM call, so this is forwarded to the worker to keep the
   * main thread free for its duration. Without a worker (`useWorker: false`,
   * or an environment with no `Worker`) it still runs in-thread and blocks.
   *
   * The batch is always proven by the client's built-in local prover: the
   * batch API takes no prover, so `proverUrl` does not apply here as it does
   * to `submit()`. And a free main thread is not a concurrent client: the call
   * holds `_serializeWasmCall` throughout, so reads, syncs, and other
   * forwarded methods still queue behind it. What changes is that the page
   * keeps painting.
   *
   * @param {BatchItem[]} items - (account, request) pairs; the accounts may
   *   differ from item to item.
   * @returns {Promise<number>} The node's chain tip as of submission, not the
   *   block the batch commits in. Sync to learn where it landed.
   */
  async submitNewTransactionBatch(items) {
    return this._serializeWasmCall(async () => {
      const wasm = await getWasmOrThrow();
      assertBatchItems(items, wasm.BatchItem);
      return await this._dispatchBatch(items);
    }, MethodName.SUBMIT_NEW_TRANSACTION_BATCH);
  }

  /**
   * Resubmits an already-proven batch after an indeterminate admission response.
   *
   * Pass the `submission` from a batch failure with
   * `code: "BATCH_SUBMISSION_OUTCOME_UNKNOWN"` (in-thread), or
   * `{ submissionId }` / the `submissionId` string from a worker-backed
   * failure. Does not re-execute or re-prove. Returns the node's chain tip on
   * acceptance.
   *
   * @param {object|string} submission - ProvenBatchSubmission handle, or a
   *   worker `submissionId` / `{ submissionId }` from the unknown-outcome error.
   * @returns {Promise<number>}
   */
  async retryProvenBatch(submission) {
    return this._serializeWasmCall(async () => {
      if (this.worker) {
        const submissionId =
          typeof submission === "string"
            ? submission
            : submission?.submissionId;
        if (!submissionId) {
          throw new Error(
            "retryProvenBatch under a worker needs submission.submissionId from the BATCH_SUBMISSION_OUTCOME_UNKNOWN error"
          );
        }
        return await this.callMethodWithWorker(
          MethodName.RETRY_PROVEN_BATCH,
          String(submissionId)
        );
      }
      const wasmWebClient = await this.getWasmWebClient();
      const handle =
        submission?.submission !== undefined
          ? submission.submission
          : submission;
      return await wasmWebClient.retryProvenBatch(handle);
    }, MethodName.RETRY_PROVEN_BATCH);
  }

  /**
   * Submits a batch and returns the transactions stored before and after it,
   * from the one chain slot observed as `submitNewTransactionBatch`.
   *
   * Both reads call `TransactionFilter.all()` on the main-thread client. The
   * filter binding is consumed by value, so each read calls `all()` itself,
   * and a row that is already committed or discarded is still present.
   * `_dispatchBatch` is the worker, in-thread, or mock submit and finishes
   * its store write before the second read.
   *
   * This does not call `submitNewTransactionBatch`: that method takes its own
   * chain slot, and from inside this one the inner call would queue behind
   * the outer one and deadlock.
   *
   * @param {BatchItem[]} items - (account, request) pairs to submit.
   * @returns {Promise<{ blockNumber: number, before: Array, after: Array }>}
   */
  async _submitNewTransactionBatchForWait(items) {
    return this._serializeWasmCall(async () => {
      const wasm = await getWasmOrThrow();
      assertBatchItems(items, wasm.BatchItem);
      const wasmClient = await this.getWasmWebClient();
      const before = await wasmClient.getTransactions(
        wasm.TransactionFilter.all()
      );
      const blockNumber = await this._dispatchBatch(items);
      const after = await wasmClient.getTransactions(
        wasm.TransactionFilter.all()
      );
      return { blockNumber, before, after };
    }, MethodName.SUBMIT_NEW_TRANSACTION_BATCH);
  }

  /**
   * Runs a validated batch in the worker when there is one, else in-thread.
   * The caller already holds the chain slot, so this must not join the chain
   * again: the inner call would queue behind the outer one and deadlock.
   *
   * @param {BatchItem[]} items - Already validated.
   * @returns {Promise<number>}
   */
  async _dispatchBatch(items) {
    if (!this.worker) {
      return this._submitBatchInThread(items);
    }

    try {
      // A `BatchItem` is a handle into this thread's WASM memory, so each
      // one crosses as its parts and the worker rebuilds it.
      const serializedItems = items.map((item) => [
        item.accountId().toString(),
        item.request().serialize(),
      ]);
      return await this.callMethodWithWorker(
        MethodName.SUBMIT_NEW_TRANSACTION_BATCH,
        serializedItems
      );
    } catch (error) {
      console.error(
        "INDEX.JS: Error in submitNewTransactionBatch (worker):",
        error
      );
      throw error;
    }
  }

  /**
   * Runs a batch on this thread's WASM instance. Shared by the no-worker case
   * above and by `MockWebClient`, which always takes this path. Like
   * `_dispatchBatch`, it runs inside the caller's chain slot.
   *
   * @param {BatchItem[]} items - Already validated.
   * @returns {Promise<number>}
   */
  async _submitBatchInThread(items) {
    try {
      const wasmWebClient = await this.getWasmWebClient();
      try {
        return await wasmWebClient.submitNewTransactionBatch(items);
      } catch (error) {
        const authError = wasmWebClient.lastAuthError();
        if (typeof error === "string") {
          throw appendAuthError(error, authError);
        }
        if (error instanceof Error) {
          error.message = appendAuthError(error.message, authError);
        }
        throw error;
      }
    } catch (error) {
      console.error(
        "INDEX.JS: Error in submitNewTransactionBatch (in-thread):",
        error
      );
      throw error;
    }
  }

  async submitNewTransactionWithProver(accountId, transactionRequest, prover) {
    return this._serializeWasmCall(async () => {
      try {
        if (!this.worker) {
          const wasmWebClient = await this.getWasmWebClient();
          try {
            return await wasmWebClient.submitNewTransactionWithProver(
              accountId,
              transactionRequest,
              prover
            );
          } catch (error) {
            const authError = wasmWebClient.lastAuthError();
            if (typeof error === "string")
              throw appendAuthError(error, authError);
            if (error instanceof Error) {
              error.message = appendAuthError(error.message, authError);
            }
            throw error;
          }
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
          try {
            return await wasmWebClient.executeTransaction(
              accountId,
              transactionRequest
            );
          } catch (error) {
            const authError = wasmWebClient.lastAuthError();
            if (typeof error === "string") {
              throw appendAuthError(error, authError);
            }
            if (error instanceof Error) {
              error.message = appendAuthError(error.message, authError);
            }
            throw error;
          }
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
          try {
            return await wasmWebClient.executeTransactionAt(
              accountId,
              transactionRequest,
              anchor
            );
          } catch (error) {
            const authError = wasmWebClient.lastAuthError();
            if (typeof error === "string") {
              throw appendAuthError(error, authError);
            }
            if (error instanceof Error) {
              error.message = appendAuthError(error.message, authError);
            }
            throw error;
          }
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
    const run = async () => {
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
    };
    return this._serializeWasmCall(
      run,
      MethodName.PROVE_TRANSACTION,
      undefined,
      {
        workerOnly: !!this.worker,
      }
    );
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
      // A worker-only sync still takes its ordered slot before the store lock.
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
        methodId,
        { workerOnly: true }
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
        methodId,
        { workerOnly: true }
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
        methodId,
        { workerOnly: true }
      );
    } catch (error) {
      console.error("INDEX.JS: Error in syncChain:", error);
      throw error;
    }
  }

  /**
   * Latches the worker as dead: stops it, rejects `ready` and every pending
   * request, and makes every later worker call throw the same error until
   * terminate(). After terminate(), those calls throw "WebClient terminated".
   * The worker never recovers, so a late message from it is not answered.
   * @private
   */
  _failWorker(reason) {
    if (this._terminated || this._workerFailure) {
      return;
    }
    const error = new Error(`WebClient worker failed: ${reason}`);
    console.error(error.message);
    this._workerFailure = error;
    this.worker.terminate();
    this.readyRejecter(error);
    for (const { reject } of this.pendingRequests.values()) {
      reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * The error that latched this client's worker as dead, or undefined until
   * the worker fails. Every later worker call throws this same Error until
   * terminate(). After terminate(), those calls throw "WebClient terminated".
   * @returns {Error | undefined}
   */
  get workerFailure() {
    return this._workerFailure;
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
   * WasmWebClient.terminate() releases only the store's ownership claim.
   */
  terminate() {
    this._terminated = true;
    this._releaseStore?.();
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
   * Runs teardown after the ordered chain and any admitted reads settle.
   * @private
   */
  _afterQueuedWasmCalls(step) {
    this._wasmCallChain = this._wasmCallChain
      .then(async () => {
        await Promise.allSettled(this._activeLocalReads ?? []);
        await step();
      })
      .catch(() => {});
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
  constructor(seed, logLevel, storeName) {
    super(
      null,
      null,
      seed,
      storeName ?? MOCK_STORE_NAME,
      undefined,
      undefined,
      undefined,
      logLevel
    );
    // The worker's mock client has to start from the main thread's mock
    // chain: both clients open the same IndexedDB store, and a worker that
    // built its own chain could store that chain's genesis header first.
    // Every later sync against the main chain would then fail validation
    // ("does not carry valid validator signatures"). `createClient` resolves
    // this once the main-thread chain exists. Pass a distinct `storeName` when
    // a second mock client must not share that database with another live mock.
    this.mockChainReady = new Promise((resolve) => {
      this.resolveMockChainReady = resolve;
    });
  }

  initializeWorker() {
    // Pass `numThreads` exactly like the real INIT path: rayon's pool is
    // per-instance, so without this any mock proving that reaches the worker
    // silently runs single-threaded.
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
    this.mockChainReady.then(
      async ([serializedMockChain, serializedMockNoteTransportNode]) => {
        let wasmUrl;
        if (WebClient._shouldUseClassicWorker()) {
          try {
            wasmUrl = await resolveWasmUrl();
          } catch (error) {
            this.readyRejecter(error);
            return;
          }
        }
        this.worker.postMessage({
          action: WorkerAction.INIT_MOCK,
          args: [
            this.seed,
            this.logLevel,
            numThreads,
            serializedMockChain,
            serializedMockNoteTransportNode,
            this.storeName,
            wasmUrl,
          ],
        });
      }
    );
  }

  /**
   * Factory method to create a WebClient with a mock chain for testing purposes.
   *
   * @param serializedMockChain - Serialized mock chain data (optional). Will use an empty chain if not provided.
   * @param serializedMockNoteTransportNode - Serialized mock note transport node data (optional). Will use a new instance if not provided.
   * @param seed - The seed for the account (optional).
   * @param logLevel - Optional log level.
   * @param storeName - Optional IndexedDB name. Defaults to `mock_client_db`. Use a distinct name for a second independent mock in the same origin.
   * @returns A promise that resolves to a MockWebClient.
   */
  static async createClient(
    serializedMockChain,
    serializedMockNoteTransportNode,
    seed,
    logLevel,
    storeName
  ) {
    // Construct the instance (synchronously).
    const instance = new MockWebClient(seed, logLevel, storeName);

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
        instance.storeName
      );

      // Hand the main-thread chain to the worker's INIT_MOCK.
      instance.resolveMockChainReady([
        (await wasmWebClient.serializeMockChain()).buffer,
        (await wasmWebClient.serializeMockNoteTransportNode()).buffer,
      ]);

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
            this.storeName
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

  /**
   * Mock clients deliberately keep batching on the main thread.
   *
   * The mock submit handlers round-trip the mock chain: the serialized chain
   * travels to the worker and the mutated chain is adopted back. That works
   * for a submitted transaction, which lands in `pending_transactions` and is
   * serialized. A submitted *batch* lands in `pending_batches`, which
   * `MockChain`'s serializer does not write and its deserializer resets to
   * empty. Shipping the chain back would therefore discard the whole batch
   * while the shared store had already recorded its per-transaction updates —
   * the nonce would advance on a chain that never saw the batch.
   *
   * Overriding is required rather than merely preferable: inheriting the base
   * dispatch would forward to the worker, since a mock client has one.
   *
   * Note that this keeps the batch out of its own round trip, not out of every
   * later one — call `proveBlock()` after a mock batch, before submitting
   * anything else.
   */
  async _dispatchBatch(items) {
    return this._submitBatchInThread(items);
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
            this.storeName
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
MidenClient._createTrustedHandle = createTrustedHandle;
_setStandaloneWebClient(WebClient);

/**
 * @internal Test-only seam. Exercises `_serializeWasmCall`'s observation
 * contract without constructing a real WASM-backed client. The host carries
 * the flag exactly as the constructor would have sealed it — a normalized
 * boolean — because `_serializeWasmCall` takes no per-call override.
 */
export function __serializeWasmCallForTest(fn, opName, observabilityConfig) {
  const host = {
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
