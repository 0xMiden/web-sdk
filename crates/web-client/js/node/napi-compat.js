/**
 * NAPI compatibility layer.
 *
 * Normalizes differences between the napi (Node.js) and wasm-bindgen (browser)
 * SDK surfaces so the shared MidenClient wrapper works on both platforms.
 *
 * Key normalizations:
 * - Uint8Array/Buffer -> Array for Vec<u8> parameters (e.g. RNG seeds)
 * - deserialize args pass through: napi's JsBytes accepts any Uint8Array view
 * - BigUint64Array/BigInt64Array -> Array (napi's Vec<u64>/Vec<BigInt> expects plain arrays)
 * - null -> undefined (napi returns null for Option::None, wasm-bindgen returns undefined)
 * - camelCase -> snake_case aliases (napi uses camelCase, wasm-bindgen uses snake_case)
 * - Array type polyfills (browser has typed WASM arrays, napi accepts plain JS arrays)
 */

// ── Argument normalization ───────────────────────────────────────────

/**
 * Normalizes a single argument for napi compatibility.
 *
 * `BigInt` values are passed through untouched — napi-rs accepts JS `BigInt`
 * for `u64` parameters (via `napi::bindgen_prelude::BigInt`), so no conversion
 * is needed. Typed arrays of BigInts and bytes are converted to plain arrays.
 */
export function normalizeArg(val) {
  if (val instanceof BigUint64Array) return Array.from(val);
  if (val instanceof BigInt64Array) return Array.from(val);
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) return Array.from(val);
  return unwrapContainer(val);
}

/**
 * Returns the plain array behind a Node array container (napi's `Vec<T>` needs
 * a real Array) and any other value unchanged, so bytes reach JsBytes as given.
 */
export function unwrapContainer(val) {
  if (val && typeof val === "object" && Array.isArray(val.__midenItems)) {
    return val.__midenItems;
  }
  return val;
}

// ── Class wrapping ───────────────────────────────────────────────────

/**
 * Builds a native instance for a class wrapper. new.target carries a subclass's
 * prototype through `super()`; a plain call (no `new`) builds for the wrapper.
 */
function construct(Cls, args, newTarget, Wrapper) {
  const target = newTarget ?? Wrapper;
  const instance = Reflect.construct(Cls, args, target);
  if (Object.getPrototypeOf(instance) !== target.prototype) {
    Object.setPrototypeOf(instance, target.prototype);
  }
  return instance;
}

/**
 * Wraps a napi class so constructor and static method args are normalized,
 * except `deserialize`, whose JsBytes argument passes through unchanged.
 */
export function wrapClass(Cls) {
  if (!Cls) return Cls;
  const Wrapper = function (...args) {
    return construct(Cls, args.map(normalizeArg), new.target, Wrapper);
  };
  Object.defineProperty(Wrapper, "name", {
    value: Cls.name,
    configurable: true,
  });
  Wrapper.prototype = Cls.prototype;
  for (const key of Object.getOwnPropertyNames(Cls)) {
    if (key === "prototype" || key === "length" || key === "name") continue;
    const desc = Object.getOwnPropertyDescriptor(Cls, key);
    if (desc && typeof desc.value === "function") {
      // deserialize takes JsBytes, which reads a Buffer or any Uint8Array view
      // at its own offset; flattening it to an Array (as for Vec<u8>) fails.
      Wrapper[key] =
        key === "deserialize"
          ? desc.value.bind(Cls)
          : (...args) => desc.value.apply(Cls, args.map(normalizeArg));
    } else if (desc) {
      try {
        Object.defineProperty(Wrapper, key, desc);
      } catch {
        /* skip non-configurable */
      }
    }
  }
  return Wrapper;
}

// ── Client wrapping ──────────────────────────────────────────────────

/**
 * Wraps a raw napi WebClient to normalize API differences with the browser SDK.
 *
 * - syncState() -> syncStateImpl() (no browser lock coordination needed)
 * - syncChain() -> syncChainImpl()
 * - syncNoteTransport() -> syncNoteTransportImpl()
 * - null -> undefined for Option<T> returns
 * - BigInt/Uint8Array args normalized
 */
export function wrapClient(rawClient, storeName) {
  return new Proxy(rawClient, {
    get(target, prop) {
      if (prop === "syncState") {
        return (...args) => target.syncStateImpl(...args);
      }
      if (prop === "syncChain") {
        return () => target.syncChainImpl();
      }
      if (prop === "syncNoteTransport") {
        return () => target.syncNoteTransportImpl();
      }
      if (prop === "storeName") {
        return storeName || "default";
      }
      if (prop === "wasmWebClient") {
        return target;
      }
      if (prop === "storeIdentifier") {
        return () => target.storeIdentifier?.() ?? storeName ?? "unknown";
      }
      // terminate is a no-op on Node.js (no Web Worker to terminate)
      if (prop === "terminate") {
        return () => {};
      }
      // onStateChanged is browser-only (uses BroadcastChannel)
      if (prop === "onStateChanged") {
        return () => undefined;
      }
      // waitForIdle drains the browser SDK's detached `_serializeWasmCall`
      // chain. The napi binding has no such chain — every call is awaited
      // directly by its caller and serialized inside Rust — so there is
      // nothing in flight by the time a caller could invoke this. Resolve
      // immediately to keep the cross-platform MidenClient surface intact.
      if (prop === "waitForIdle") {
        return () => Promise.resolve();
      }
      // lastAuthError surfaces the raw value a JS sign callback threw.
      // The Node binding signs with FilesystemKeyStore (no JS callback can
      // ever run), so "no sign error" is the semantically correct answer,
      // not a stub.
      if (prop === "lastAuthError") {
        return () => null;
      }
      if (prop === "newWallet") {
        return (mode, authScheme, seed) => {
          const normSeed =
            seed instanceof Uint8Array || Buffer.isBuffer(seed)
              ? Array.from(seed)
              : seed;
          return target
            .newWallet(mode, authScheme, normSeed ?? null)
            .then((v) => (v === null ? undefined : v));
        };
      }
      const val = target[prop];
      if (typeof val === "function") {
        const bound = val.bind(target);
        return (...args) => {
          const result = bound(...args.map(normalizeArg));
          if (result && typeof result.then === "function") {
            return result.then((v) => (v === null ? undefined : v));
          }
          return result === null ? undefined : result;
        };
      }
      return val;
    },
  });
}

// ── Prototype patching ───────────────────────────────────────────────

/**
 * Patches the raw SDK module:
 * - Adds snake_case aliases for camelCase methods
 * - Converts null -> undefined for Option<T> returns
 * - Aliases static methods
 */
function patchSdkPrototypes(rawSdk) {
  // snake_case aliases for instance methods
  /* eslint-disable camelcase */
  for (const [cls, aliases] of [
    [rawSdk.Account, { to_commitment: "toCommitment" }],
    [rawSdk.AccountHeader, { to_commitment: "toCommitment" }],
  ]) {
    if (!cls?.prototype) continue;
    for (const [snake, camel] of Object.entries(aliases)) {
      if (typeof cls.prototype[camel] === "function" && !cls.prototype[snake]) {
        cls.prototype[snake] = cls.prototype[camel];
      }
    }
  }
  /* eslint-enable camelcase */

  // null -> undefined for Option<T> return methods
  for (const [cls, methods] of [
    [rawSdk.AccountPatch, ["finalNonce"]],
    [rawSdk.AccountStorage, ["getItem", "getMapEntries", "getMapItem"]],
    [rawSdk.AdviceMap, ["get", "insert"]],
    // `feeNote` is absent whenever the chain charges nothing, which is the common case on a
    // local chain, so the "no fee note" reading has to be the same on both bindings.
    [rawSdk.ExecutedTransaction, ["feeNote"]],
    [rawSdk.NoteConsumptionStatus, ["consumableAfterBlock"]],
    // `authArg` and `feeConversionSalt` are how a caller checks what a request
    // declared about paying its fee, so they have to read the same on both
    // bindings — the salt tests in `fee_conversion_salt.test.ts` compare with
    // `== null` for exactly this reason.
    [rawSdk.TransactionRequest, ["authArg", "feeConversionSalt", "scriptArg"]],
  ]) {
    if (!cls?.prototype) continue;
    for (const method of methods) {
      const original = cls.prototype[method];
      if (typeof original === "function") {
        cls.prototype[method] = function (...args) {
          const result = original.apply(this, args);
          return result === null ? undefined : result;
        };
      }
    }
  }

  // snake_case aliases for static methods
  if (rawSdk.NoteScript) {
    if (!rawSdk.NoteScript.p2id && rawSdk.NoteScript.p2Id)
      rawSdk.NoteScript.p2id = rawSdk.NoteScript.p2Id;
    if (!rawSdk.NoteScript.p2ide && rawSdk.NoteScript.p2Ide)
      rawSdk.NoteScript.p2ide = rawSdk.NoteScript.p2Ide;
  }
}

// ── Container boundary ───────────────────────────────────────────────

// Native methods whose declared result is a container: napi returns a plain
// Array, which the browser-typed caller reads with length() and get().
const CONTAINER_RESULTS = [
  ["SigningInputs", "toElements"],
  ["SigningInputs", "arbitraryPayload"],
  ["TransactionScriptInputPair", "felts"],
  ["WebClient", "executeProgram"],
];

const toContainer = (value) =>
  Array.isArray(value) ? makeContainer(value) : value;

function isNativeClass(value) {
  return typeof value === "function" && typeof value.prototype === "object";
}

/**
 * Makes every native entry point take Node array containers: prototype methods
 * of every class are patched in place (raw instances such as a fee-aware
 * request builder use them too), and the returned module replaces each class
 * with a wrapper whose constructor and static methods unwrap their arguments.
 */
function unwrapContainersAtNapiBoundary(rawSdk) {
  const containerResults = new Set(
    CONTAINER_RESULTS.map(([cls, method]) => `${cls}.${method}`)
  );
  const wrapped = {};
  for (const [name, value] of Object.entries(rawSdk)) {
    if (!isNativeClass(value)) continue;
    for (const key of Object.getOwnPropertyNames(value.prototype)) {
      if (key === "constructor") continue;
      const desc = Object.getOwnPropertyDescriptor(value.prototype, key);
      if (typeof desc?.value !== "function" || !desc.writable) continue;
      const original = desc.value;
      const wrapsResult = containerResults.has(`${name}.${key}`);
      value.prototype[key] = function (...args) {
        const result = original.apply(this, args.map(unwrapContainer));
        if (!wrapsResult) return result;
        return typeof result?.then === "function"
          ? result.then(toContainer)
          : toContainer(result);
      };
    }
    wrapped[name] = wrapNativeClass(value);
  }
  return wrapped;
}

/**
 * Like wrapClass, but only unwraps containers, so byte arguments pass as given.
 * napi functions also carry a prototype, so a plain call stays a plain call.
 */
function wrapNativeClass(Cls) {
  const Wrapper = function (...args) {
    const unwrapped = args.map(unwrapContainer);
    return new.target
      ? construct(Cls, unwrapped, new.target, Wrapper)
      : Cls.apply(this, unwrapped);
  };
  Object.defineProperty(Wrapper, "name", {
    value: Cls.name,
    configurable: true,
  });
  Wrapper.prototype = Cls.prototype;
  for (const key of Object.getOwnPropertyNames(Cls)) {
    if (key === "prototype" || key === "length" || key === "name") continue;
    const desc = Object.getOwnPropertyDescriptor(Cls, key);
    if (desc && typeof desc.value === "function") {
      Wrapper[key] = (...args) =>
        desc.value.apply(Cls, args.map(unwrapContainer));
    } else if (desc) {
      try {
        Object.defineProperty(Wrapper, key, desc);
      } catch {
        /* skip non-configurable */
      }
    }
  }
  return Wrapper;
}

// ── Array polyfills ──────────────────────────────────────────────────

/**
 * Array containers declared by `declare_js_miden_arrays!` in src/models/mod.rs.
 * On Node they are JS polyfills, so node-index.js re-exports them from this
 * list (see scripts/gen-node-reexports.js).
 */
export const NODE_ARRAY_TYPES = Object.freeze([
  "AccountArray",
  "AccountIdArray",
  "FeltArray",
  "ForeignAccountArray",
  "NoteAndArgsArray",
  "NoteArray",
  "NoteDetailsAndTagArray",
  "NoteIdAndArgsArray",
  "NoteRecipientArray",
  "OutputNoteArray",
  "StorageSlotArray",
  "TransactionScriptInputPairArray",
]);

/**
 * Browser `declare_js_miden_arrays!` containers expose `length()` as a method.
 * A plain JS Array cannot also have a callable `length`, so Node uses a thin
 * wrapper whose underlying items are unwrapped at every napi entry point
 * (`unwrapContainer`).
 */
function makeContainer(items) {
  const arr =
    items === undefined || items === null
      ? []
      : Array.isArray(items)
        ? [...items]
        : items &&
            typeof items === "object" &&
            Array.isArray(items.__midenItems)
          ? [...items.__midenItems]
          : [items];

  const checkIndex = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= arr.length) {
      throw new RangeError(
        `out of bounds access -- tried to access at index: ${i} with length ${arr.length}`
      );
    }
  };

  // The mutators return the Proxy the caller holds, not this target object.
  let container;
  const wrapper = {
    __midenItems: arr,
    get(i) {
      checkIndex(i);
      return arr[i];
    },
    replaceAt(i, val) {
      checkIndex(i);
      arr[i] = val;
      return container;
    },
    push(val) {
      arr.push(val);
      return container;
    },
    length() {
      return arr.length;
    },
    free() {},
    [Symbol.iterator]() {
      return arr[Symbol.iterator]();
    },
  };
  if (Symbol.dispose) wrapper[Symbol.dispose] = wrapper.free;

  // Indexed access parity with browser/wasm containers and plain arrays.
  container = new Proxy(wrapper, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        const i = Number(prop);
        return i >= 0 && i < arr.length ? arr[i] : undefined;
      }
      // Do not shadow length() with a numeric length property: browser
      // typed code calls length() and must work on Node too (#427).
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        const i = Number(prop);
        if (i >= 0 && i < arr.length) {
          arr[i] = value;
          return true;
        }
        return false;
      }
      return Reflect.set(target, prop, value, receiver);
    },
    ownKeys() {
      return [
        ...Object.keys(arr),
        ...Reflect.ownKeys(wrapper).filter((k) => k !== "__midenItems"),
      ];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        const i = Number(prop);
        if (i >= 0 && i < arr.length) {
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: arr[i],
          };
        }
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  return container;
}

/**
 * Creates polyfill constructors for WASM typed array types.
 * napi accepts plain JS arrays directly, but the browser SDK requires
 * typed wrappers (NoteAndArgsArray, FeltArray, etc.). These polyfills
 * let `new sdk.FeltArray([a, b])` work on Node.js by returning a container.
 */
function makeArrayPolyfills() {
  function ArrayCtor(items) {
    return makeContainer(items);
  }

  return Object.fromEntries(NODE_ARRAY_TYPES.map((name) => [name, ArrayCtor]));
}

// ── SDK wrapper ──────────────────────────────────────────────────────

/**
 * Creates a wrapped SDK module suitable for use with the MidenClient wrapper.
 * Applies all patches and returns an object that can be used as `getWasm()` return value.
 */
export function createSdkWrapper(rawSdk) {
  // Aliases and patches first, so the wrappers copy every static (NoteScript.p2id)
  // and the container patch wraps every prototype method, aliases included.
  patchSdkPrototypes(rawSdk);
  const nativeClasses = unwrapContainersAtNapiBoundary(rawSdk);

  const sdk = {
    ...rawSdk,
    ...nativeClasses,
    // Wrap classes whose constructors/static methods accept BigInt or Uint8Array
    AccountBuilder: wrapClass(rawSdk.AccountBuilder),
    AccountComponent: wrapClass(rawSdk.AccountComponent),
    AuthSecretKey: wrapClass(rawSdk.AuthSecretKey),
    Felt: wrapClass(rawSdk.Felt),
    FungibleAsset: wrapClass(rawSdk.FungibleAsset),
    Word: wrapClass(rawSdk.Word),
    NoteTag: wrapClass(rawSdk.NoteTag),
    // Array type polyfills
    ...makeArrayPolyfills(),
  };
  // A wrapper shares its class's prototype, so instances report the final
  // export, whichever wrapper produced it, as their constructor.
  for (const [name, exported] of Object.entries(sdk)) {
    const raw = rawSdk[name];
    if (exported === raw || !isNativeClass(raw)) continue;
    if (exported?.prototype !== raw.prototype) continue;
    const desc = Object.getOwnPropertyDescriptor(raw.prototype, "constructor");
    if (desc && !desc.writable && !desc.configurable) continue;
    Object.defineProperty(raw.prototype, "constructor", {
      value: exported,
      writable: true,
      configurable: true,
    });
  }
  return sdk;
}
