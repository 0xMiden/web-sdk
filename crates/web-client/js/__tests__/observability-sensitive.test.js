import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// `js/index.js` re-exports the wasm-bindgen surface with
// `export * from "../Cargo.toml"`, which the node test environment cannot
// parse (the rollup rust plugin resolves it only during a real build).
// Stubbing that one specifier makes the wrapper's own JS testable; nothing
// below touches WASM.
vi.mock("../../Cargo.toml", () => ({}));

// `_serializeWasmCall` withholds the `sensitive` key, and the sink withholds
// it again — two independent locks on the same door. An assertion made on
// what the observer finally receives cannot tell the two apart, so the sink
// is wrapped here to let a test assert on the object the wrapper hands over.
// Without that, the wrapper's own guard would be untested code sitting on a
// privacy boundary, held up only by the sink continuing to filter for it.
vi.mock("../observability.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, emitObservation: vi.fn(actual.emitObservation) };
});

import {
  WasmWebClient,
  __serializeWasmCallForTest as serialize,
  __resetSensitiveWarningForTest,
} from "../index.js";
import {
  emitObservation,
  setObserver,
  __resetObserverForTest,
} from "../observability.js";

/** The only keys an observation may carry when the channel is off. */
const SAFE_KEYS = ["op", "outcome", "durationMs"];

const ACCOUNT_ID = "mtst1qqqqqsecretaccountid";
const RAW_ERROR = `account ${ACCOUNT_ID} has insufficient balance`;

/** The observation with the high-fidelity channel stripped off. */
function nonSensitive(observation) {
  const safe = { ...observation };
  delete safe.sensitive;
  return safe;
}

/**
 * Construct a real wrapper with the worker shim off, which is the one path
 * through the constructor that needs neither a `Worker` nor WASM.
 */
function newClient(observability) {
  return new WasmWebClient(
    null,
    null,
    undefined,
    "observability-sensitive-test-store",
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    observability
  );
}

/** A host carrying just the state `_serializeWasmCall` reads. */
function makeHost(observeSensitive) {
  return {
    _withInnerLockDepth: 0,
    _wasmCallChain: Promise.resolve(),
    _observeSensitive: observeSensitive,
    _serializeWasmCall: WasmWebClient.prototype._serializeWasmCall,
  };
}

beforeEach(() => {
  __resetSensitiveWarningForTest();
  emitObservation.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  __resetObserverForTest();
  vi.restoreAllMocks();
});

describe("high-fidelity channel", () => {
  it("carries error message and stack when enabled", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    const boom = new Error(RAW_ERROR);
    await serialize(
      async () => {
        throw boom;
      },
      "syncState",
      { observeSensitive: true }
    ).catch(() => {});
    expect(seen).toHaveLength(1);
    expect(seen[0].sensitive.errorMessage).toBe(RAW_ERROR);
    expect(seen[0].sensitive.errorStack).toBe(boom.stack);
  });

  it("keeps the safe fields intact alongside the sensitive channel", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(
      async () => {
        throw new Error(RAW_ERROR);
      },
      "proveTransaction",
      { observeSensitive: true }
    ).catch(() => {});
    expect(seen).toHaveLength(1);
    expect(seen[0].op).toBe("proveTransaction");
    expect(seen[0].outcome).toBe("error");
    expect(typeof seen[0].durationMs).toBe("number");
  });

  it("omits the sensitive key when disabled, even on error", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(
      async () => {
        throw new Error(RAW_ERROR);
      },
      "syncState",
      { observeSensitive: false }
    ).catch(() => {});
    // Positive fact first: an observation was delivered, so the absence
    // below cannot be satisfied by nothing having been emitted.
    expect(seen).toHaveLength(1);
    expect(seen[0].outcome).toBe("error");
    expect("sensitive" in seen[0]).toBe(false);
  });

  it("omits the sensitive key when the flag is simply not set", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(async () => {
      throw new Error(RAW_ERROR);
    }, "syncState").catch(() => {});
    expect(seen).toHaveLength(1);
    expect("sensitive" in seen[0]).toBe(false);
  });

  // `undefined`, `{}`, and absent are three different answers to "is the
  // channel on?". A consumer branching on `"sensitive" in observation` has
  // to be able to tell "not enabled" from "enabled but empty".
  it("leaves sensitive absent rather than undefined or empty when disabled", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(
      async () => {
        throw new Error(RAW_ERROR);
      },
      "syncState",
      { observeSensitive: false }
    ).catch(() => {});
    expect(seen).toHaveLength(1);
    const observation = seen[0];
    expect("sensitive" in observation).toBe(false);
    expect(Object.keys(observation).sort()).toEqual([...SAFE_KEYS].sort());
    expect(Object.prototype.hasOwnProperty.call(observation, "sensitive")).toBe(
      false
    );
    expect(JSON.stringify(observation)).not.toContain("sensitive");
  });

  it("omits the sensitive key on success even when enabled", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(async () => "fine", "syncState", {
      observeSensitive: true,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].outcome).toBe("ok");
    expect("sensitive" in seen[0]).toBe(false);
    expect(Object.keys(seen[0]).sort()).toEqual([...SAFE_KEYS].sort());
  });

  it("never leaks error text into safe fields", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(
      async () => {
        throw new Error(RAW_ERROR);
      },
      "syncState",
      { observeSensitive: false }
    ).catch(() => {});
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toContain(ACCOUNT_ID);
    expect(JSON.stringify(seen[0])).not.toContain("insufficient balance");
  });

  it("keeps identifiers and raw error text out of the safe fields even when enabled", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(
      async () => {
        throw new Error(RAW_ERROR);
      },
      "syncState",
      { observeSensitive: true }
    ).catch(() => {});
    expect(seen).toHaveLength(1);
    // Positive fact: the channel really is populated for this call, so the
    // assertions below are about placement, not about nothing happening.
    expect(seen[0].sensitive.errorMessage).toContain(ACCOUNT_ID);

    const safe = nonSensitive(seen[0]);
    expect(Object.keys(safe).sort()).toEqual([...SAFE_KEYS].sort());
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain(ACCOUNT_ID);
    expect(serialized).not.toContain("insufficient balance");
    expect(serialized).not.toContain("Error");
  });

  it("rethrows the original error unchanged when the channel is on", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    const boom = new Error(RAW_ERROR);
    await expect(
      serialize(
        async () => {
          throw boom;
        },
        "syncState",
        { observeSensitive: true }
      )
    ).rejects.toBe(boom);
    expect(seen).toHaveLength(1);
  });

  it("emits exactly one observation when the channel is on", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(
      async () => {
        throw new Error(RAW_ERROR);
      },
      "syncState",
      { observeSensitive: true }
    ).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toHaveLength(1);
  });
});

// The sink already refuses to attach an undefined `sensitive`, so these
// assertions are about the wrapper independently refusing to offer one. Both
// have to hold: a sink that stopped filtering must not become a leak.
describe("the sensitive key is withheld before it reaches the sink", () => {
  it("hands the sink no sensitive key at all when the channel is off", async () => {
    setObserver(() => {});
    await serialize(
      async () => {
        throw new Error(RAW_ERROR);
      },
      "syncState",
      { observeSensitive: false }
    ).catch(() => {});
    expect(emitObservation).toHaveBeenCalledTimes(1);
    const fields = emitObservation.mock.calls[0][0];
    expect(fields.outcome).toBe("error");
    expect("sensitive" in fields).toBe(false);
  });

  it("hands the sink the sensitive key when the channel is on", async () => {
    setObserver(() => {});
    await serialize(
      async () => {
        throw new Error(RAW_ERROR);
      },
      "syncState",
      { observeSensitive: true }
    ).catch(() => {});
    expect(emitObservation).toHaveBeenCalledTimes(1);
    const fields = emitObservation.mock.calls[0][0];
    expect("sensitive" in fields).toBe(true);
    expect(fields.sensitive.errorMessage).toBe(RAW_ERROR);
  });

  it("hands the sink no sensitive key on the success path", async () => {
    setObserver(() => {});
    await serialize(async () => "fine", "syncState", {
      observeSensitive: true,
    });
    expect(emitObservation).toHaveBeenCalledTimes(1);
    const fields = emitObservation.mock.calls[0][0];
    expect(fields.outcome).toBe("ok");
    expect("sensitive" in fields).toBe(false);
  });
});

describe("high-fidelity channel with a non-Error throw", () => {
  it("stringifies a thrown non-Error into the message", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(
      async () => {
        throw "wasm panicked";
      },
      "syncState",
      { observeSensitive: true }
    ).catch(() => {});
    expect(seen).toHaveLength(1);
    expect(seen[0].sensitive.errorMessage).toBe("wasm panicked");
    expect("errorStack" in seen[0].sensitive).toBe(false);
  });

  it("omits the stack key when the error carries no stack", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    const stackless = new Error(RAW_ERROR);
    stackless.stack = undefined;
    await serialize(
      async () => {
        throw stackless;
      },
      "syncState",
      { observeSensitive: true }
    ).catch(() => {});
    expect(seen).toHaveLength(1);
    expect(seen[0].sensitive.errorMessage).toBe(RAW_ERROR);
    expect("errorStack" in seen[0].sensitive).toBe(false);
  });
});

describe("the channel is read from the client, not inferred", () => {
  it("populates sensitive for a client constructed with the flag on", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    const client = newClient({ observeSensitive: true });
    await client
      ._serializeWasmCall(async () => {
        throw new Error(RAW_ERROR);
      }, "syncState")
      .catch(() => {});
    expect(seen).toHaveLength(1);
    expect(seen[0].sensitive.errorMessage).toBe(RAW_ERROR);
  });

  it("omits sensitive for a client constructed without the flag", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    const client = newClient();
    await client
      ._serializeWasmCall(async () => {
        throw new Error(RAW_ERROR);
      }, "syncState")
      .catch(() => {});
    expect(seen).toHaveLength(1);
    expect(seen[0].outcome).toBe("error");
    expect("sensitive" in seen[0]).toBe(false);
  });

  // Only the literal boolean opens the channel. A truthy stand-in reaching
  // this point at all would mean the construction-time gate was bypassed,
  // and the safe reading of that is "off".
  it.each([["true"], [1], [{}], ["yes"], [undefined], [null]])(
    "keeps the channel closed for the non-boolean flag %p",
    async (flag) => {
      const seen = [];
      setObserver((o) => seen.push(o));
      const host = makeHost(flag);
      await host
        ._serializeWasmCall(async () => {
          throw new Error(RAW_ERROR);
        }, "syncState")
        .catch(() => {});
      expect(seen).toHaveLength(1);
      expect("sensitive" in seen[0]).toBe(false);
    }
  );

  it("opens the channel for the literal boolean true", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    const host = makeHost(true);
    await host
      ._serializeWasmCall(async () => {
        throw new Error(RAW_ERROR);
      }, "syncState")
      .catch(() => {});
    expect(seen).toHaveLength(1);
    expect(seen[0].sensitive.errorMessage).toBe(RAW_ERROR);
  });

  it("does not observe an unnamed call even with the channel on", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    const host = makeHost(true);

    // Positive control: this host does observe a named operation.
    await host._serializeWasmCall(async () => "value", "syncState");
    expect(seen).toHaveLength(1);

    await host
      ._serializeWasmCall(async () => {
        throw new Error(RAW_ERROR);
      })
      .catch(() => {});
    await Promise.resolve();
    expect(seen).toHaveLength(1);
  });
});
