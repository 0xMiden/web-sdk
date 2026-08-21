import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// `js/index.js` re-exports the wasm-bindgen surface with
// `export * from "../Cargo.toml"`, which the node test environment cannot
// parse (the rollup rust plugin resolves it only during a real build).
// Stubbing that one specifier makes the wrapper's own JS testable; nothing
// below touches WASM.
vi.mock("../../Cargo.toml", () => ({}));

import {
  MidenClient,
  WasmWebClient,
  __applyObserverOptionsForTest as applyObserverOptions,
  __createClientProxyForTest as createClientProxy,
  __resetSensitiveWarningForTest,
} from "../index.js";
import { hasObserver, __resetObserverForTest } from "../observability.js";

const STORE = "observability-test-store";

/**
 * Construct a real wrapper with the worker shim off, which is the one path
 * through the constructor that needs neither a `Worker` nor WASM.
 */
function newClient(observability) {
  return new WasmWebClient(
    null,
    null,
    undefined,
    STORE,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    observability
  );
}

beforeEach(() => {
  __resetSensitiveWarningForTest();
  // The constructor announces the worker decision on every instantiation.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  __resetObserverForTest();
  vi.restoreAllMocks();
});

describe("ClientOptions observer wiring", () => {
  it("registers nothing when no observer option is given", () => {
    applyObserverOptions({});
    expect(hasObserver()).toBe(false);
  });

  it("registers nothing when no options are given at all", () => {
    applyObserverOptions();
    expect(hasObserver()).toBe(false);
  });

  it("registers the supplied observer", () => {
    applyObserverOptions({ observer: () => {} });
    expect(hasObserver()).toBe(true);
  });

  it("ignores an observer that is not callable", () => {
    applyObserverOptions({ observer: "not-a-function" });
    expect(hasObserver()).toBe(false);
  });

  it("does not warn when observeSensitive is absent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyObserverOptions({ observer: () => {} });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns exactly once when observeSensitive is enabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyObserverOptions({ observer: () => {}, observeSensitive: true });
    applyObserverOptions({ observer: () => {}, observeSensitive: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("observeSensitive");
  });
});

describe("the high-fidelity flag is opt-in, never inferred", () => {
  it("reports disabled when observeSensitive is absent", () => {
    expect(applyObserverOptions({ observer: () => {} })).toBe(false);
  });

  it("reports enabled only for the literal boolean true", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(applyObserverOptions({ observeSensitive: true })).toBe(true);
  });

  // A truthy-but-not-true value is far more likely a wiring mistake (an
  // env var, a query param, a JSON round-trip) than a deliberate decision
  // to ship account identifiers to a third party.
  it.each([["true"], [1], [{}], [[]], ["yes"], ["1"]])(
    "reports disabled for the truthy non-boolean %p",
    (value) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(applyObserverOptions({ observeSensitive: value })).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    }
  );

  it.each([[false], [undefined], [null], [0], [""]])(
    "reports disabled for the falsy %p",
    (value) => {
      expect(applyObserverOptions({ observeSensitive: value })).toBe(false);
    }
  );
});

describe("the high-fidelity flag is construction-only", () => {
  it("defaults to disabled when the constructor gets no observability options", () => {
    expect(newClient()._observeSensitive).toBe(false);
  });

  it("is disabled when constructed with observeSensitive false", () => {
    expect(newClient({ observeSensitive: false })._observeSensitive).toBe(
      false
    );
  });

  it("is enabled when constructed with observeSensitive true", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(newClient({ observeSensitive: true })._observeSensitive).toBe(true);
  });

  it("registers the observer supplied at construction", () => {
    newClient({ observer: () => {} });
    expect(hasObserver()).toBe(true);
  });

  it("cannot be assigned after construction", () => {
    const client = newClient();
    expect(() => {
      client._observeSensitive = true;
    }).toThrow(TypeError);
    expect(client._observeSensitive).toBe(false);
  });

  it("cannot be redefined after construction", () => {
    const client = newClient();
    expect(() =>
      Object.defineProperty(client, "_observeSensitive", { value: true })
    ).toThrow(TypeError);
    expect(client._observeSensitive).toBe(false);
  });

  it("cannot be deleted after construction", () => {
    const client = newClient();
    expect(() => {
      delete client._observeSensitive;
    }).toThrow(TypeError);
    expect(client._observeSensitive).toBe(false);
  });

  it("cannot be switched on through the client proxy", () => {
    const proxy = createClientProxy(newClient());
    expect(proxy._observeSensitive).toBe(false);
    expect(() => {
      proxy._observeSensitive = true;
    }).toThrow(TypeError);
    expect(proxy._observeSensitive).toBe(false);
  });

  it("cannot be turned on by disabling it on a client that has it enabled", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = newClient({ observeSensitive: true });
    expect(() => {
      client._observeSensitive = false;
    }).toThrow(TypeError);
    expect(client._observeSensitive).toBe(true);
  });
});

describe("the WebClient factories forward the observability options", () => {
  /**
   * Stub the one WASM touchpoint on the factory path so the real static
   * runs end to end in node.
   */
  function stubWasmClient() {
    vi.spyOn(WasmWebClient.prototype, "getWasmWebClient").mockImplementation(
      async () => ({
        createClient: async () => {},
        createClientWithExternalKeystore: async () => {},
      })
    );
  }

  it("createClient stores the flag and registers the observer", async () => {
    stubWasmClient();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = await WasmWebClient.createClient(
      null,
      null,
      undefined,
      STORE,
      undefined,
      false,
      { observer: () => {}, observeSensitive: true }
    );
    expect(client._observeSensitive).toBe(true);
    expect(hasObserver()).toBe(true);
  });

  it("createClient leaves the flag off when no options are passed", async () => {
    stubWasmClient();
    const client = await WasmWebClient.createClient(
      null,
      null,
      undefined,
      STORE,
      undefined,
      false
    );
    expect(client._observeSensitive).toBe(false);
    expect(hasObserver()).toBe(false);
  });

  it("createClientWithExternalKeystore stores the flag and registers the observer", async () => {
    stubWasmClient();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = await WasmWebClient.createClientWithExternalKeystore(
      null,
      null,
      undefined,
      STORE,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { observer: () => {}, observeSensitive: true }
    );
    expect(client._observeSensitive).toBe(true);
    expect(hasObserver()).toBe(true);
  });
});

describe("MidenClient.create forwards the observability options", () => {
  let savedWebClient;
  let savedGetWasm;

  beforeEach(() => {
    savedWebClient = MidenClient._WasmWebClient;
    savedGetWasm = MidenClient._getWasmOrThrow;
  });

  afterEach(() => {
    MidenClient._WasmWebClient = savedWebClient;
    MidenClient._getWasmOrThrow = savedGetWasm;
  });

  /** Capture what `MidenClient.create` hands to the WebClient factory. */
  function captureFactory() {
    const calls = { createClient: [], createClientWithExternalKeystore: [] };
    MidenClient._WasmWebClient = {
      createClient: async (...args) => {
        calls.createClient.push(args);
        return {};
      },
      createClientWithExternalKeystore: async (...args) => {
        calls.createClientWithExternalKeystore.push(args);
        return {};
      },
    };
    MidenClient._getWasmOrThrow = async () => ({});
    return calls;
  }

  it("passes the observability options to createClient", async () => {
    const calls = captureFactory();
    const observer = () => {};
    await MidenClient.create({
      rpcUrl: "testnet",
      observer,
      observeSensitive: true,
    });
    expect(calls.createClient).toHaveLength(1);
    const observability = calls.createClient[0].at(-1);
    expect(observability.observer).toBe(observer);
    expect(observability.observeSensitive).toBe(true);
  });

  it("passes the observability options to the external-keystore factory", async () => {
    const calls = captureFactory();
    const observer = () => {};
    await MidenClient.create({
      rpcUrl: "testnet",
      keystore: { getKey: () => {}, insertKey: () => {}, sign: () => {} },
      observer,
      observeSensitive: true,
    });
    expect(calls.createClientWithExternalKeystore).toHaveLength(1);
    const observability = calls.createClientWithExternalKeystore[0].at(-1);
    expect(observability.observer).toBe(observer);
    expect(observability.observeSensitive).toBe(true);
  });

  it("passes no observability options when none were supplied", async () => {
    const calls = captureFactory();
    await MidenClient.create({ rpcUrl: "testnet" });
    const observability = calls.createClient[0].at(-1);
    expect(observability?.observer).toBeUndefined();
    expect(observability?.observeSensitive).toBeUndefined();
  });
});
