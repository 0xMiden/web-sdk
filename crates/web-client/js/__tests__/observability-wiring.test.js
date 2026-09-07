import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { setObserver, __resetObserverForTest } from "../observability.js";

// `js/index.js` re-exports the wasm-bindgen surface with
// `export * from "../Cargo.toml"`, which the node test environment cannot
// parse (the rollup rust plugin resolves it only during a real build).
// Stubbing that one specifier makes the wrapper's own JS testable; nothing
// below touches WASM.
vi.mock("../../Cargo.toml", () => ({}));

import {
  WasmWebClient,
  __serializeWasmCallForTest as serialize,
  __createClientProxyForTest as createClientProxy,
} from "../index.js";

afterEach(() => __resetObserverForTest());

/** A host carrying just the state `_serializeWasmCall` reads. */
function makeHost() {
  return {
    _withInnerLockDepth: 0,
    _wasmCallChain: Promise.resolve(),
    _serializeWasmCall: WasmWebClient.prototype._serializeWasmCall,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("_serializeWasmCall observation", () => {
  it("emits ok with the op name and a numeric duration", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(async () => "value", "syncState");
    expect(seen).toHaveLength(1);
    expect(seen[0].op).toBe("syncState");
    expect(seen[0].outcome).toBe("ok");
    expect(typeof seen[0].durationMs).toBe("number");
    expect(seen[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("measures the duration of the wrapped call", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    const wallStart = performance.now();
    await serialize(async () => sleep(30), "syncState");
    const wallElapsed = performance.now() - wallStart;
    expect(seen).toHaveLength(1);
    // A constant or unmeasured duration cannot clear this floor, and an
    // absolute clock reading cannot stay under the wall-time ceiling.
    expect(seen[0].durationMs).toBeGreaterThan(15);
    expect(seen[0].durationMs).toBeLessThanOrEqual(wallElapsed);
  });

  it("emits error and rethrows the original error", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    const boom = new Error("wasm exploded");
    await expect(
      serialize(async () => {
        throw boom;
      }, "proveTransaction")
    ).rejects.toBe(boom);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      op: "proveTransaction",
      outcome: "error",
    });
  });

  it("omits sensitive by default even on error", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(async () => {
      throw new Error("secret-bearing message");
    }, "syncState").catch(() => {});
    expect(seen).toHaveLength(1);
    expect("sensitive" in seen[0]).toBe(false);
    expect(JSON.stringify(seen[0])).not.toContain("secret-bearing");
  });

  it("does not emit when no op name is supplied", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    // Positive control: this observer does receive a named operation.
    await serialize(async () => "value", "syncState");
    expect(seen).toHaveLength(1);

    await serialize(async () => "value");
    await Promise.resolve();
    expect(seen).toHaveLength(1);
  });

  it("emits exactly one observation per call", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(async () => "value", "syncState");
    await Promise.resolve();
    expect(seen).toHaveLength(1);
  });

  it("returns the resolved value unchanged", async () => {
    setObserver(() => {});
    await expect(serialize(async () => 42, "syncState")).resolves.toBe(42);
  });

  it("delivers the observation before the caller resumes", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    let seenAtResume = -1;
    await serialize(async () => "value", "syncState").then(() => {
      seenAtResume = seen.length;
    });
    expect(seenAtResume).toBe(1);
  });

  it("keeps the operation intact when the observer throws", async () => {
    setObserver(() => {
      throw new Error("consumer telemetry is broken");
    });
    await expect(serialize(async () => "value", "syncState")).resolves.toBe(
      "value"
    );
    const boom = new Error("wasm exploded");
    await expect(
      serialize(async () => {
        throw boom;
      }, "syncState")
    ).rejects.toBe(boom);
  });
});

describe("_serializeWasmCall skips timing work when unobserved", () => {
  it("does not read the clock when no observer is registered", async () => {
    const spy = vi.spyOn(performance, "now");
    const before = spy.mock.calls.length;
    await serialize(async () => "value", "syncState");
    const unobserved = spy.mock.calls.length - before;

    // Positive control in the same test, so "no clock reads" cannot pass
    // merely because the wrapper never ran.
    setObserver(() => {});
    const beforeObserved = spy.mock.calls.length;
    await serialize(async () => "value", "syncState");
    const observed = spy.mock.calls.length - beforeObserved;
    spy.mockRestore();

    expect(observed).toBeGreaterThan(0);
    expect(unobserved).toBe(0);
  });
});

describe("_serializeWasmCall preserves call semantics", () => {
  it("serializes queued calls, observed or not", async () => {
    for (const observed of [false, true]) {
      __resetObserverForTest();
      if (observed) setObserver(() => {});
      const host = makeHost();
      const events = [];
      const gate = deferred();

      const first = host._serializeWasmCall(async () => {
        events.push("start-1");
        await gate.promise;
        events.push("end-1");
      }, "opOne");
      const second = host._serializeWasmCall(async () => {
        events.push("start-2");
        events.push("end-2");
      }, "opTwo");

      gate.resolve();
      await Promise.all([first, second]);
      expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
    }
  });

  it("reports observations in completion order", async () => {
    const seen = [];
    setObserver((o) => seen.push(o.op));
    const host = makeHost();
    const gate = deferred();
    const first = host._serializeWasmCall(() => gate.promise, "opOne");
    const second = host._serializeWasmCall(async () => "value", "opTwo");
    gate.resolve();
    await Promise.all([first, second]);
    expect(seen).toEqual(["opOne", "opTwo"]);
  });

  it("does not let a rejected call poison the chain", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    const host = makeHost();
    await expect(
      host._serializeWasmCall(async () => {
        throw new Error("wasm exploded");
      }, "opOne")
    ).rejects.toThrow("wasm exploded");
    await expect(
      host._serializeWasmCall(async () => "value", "opTwo")
    ).resolves.toBe("value");
    expect(seen.map((o) => [o.op, o.outcome])).toEqual([
      ["opOne", "error"],
      ["opTwo", "ok"],
    ]);
  });

  it("runs inline without touching the chain while an inner lock is held", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    const host = makeHost();
    host._withInnerLockDepth = 1;
    const chainBefore = host._wasmCallChain;
    await expect(
      host._serializeWasmCall(async () => "value", "opOne")
    ).resolves.toBe("value");
    expect(host._wasmCallChain).toBe(chainBefore);
    expect(seen).toHaveLength(1);
    expect(seen[0].op).toBe("opOne");
  });
});

describe("every observed call site names its operation", () => {
  // Reaching the wrapped methods for real needs a WASM-backed client, which
  // the node test environment has not got. Parsing the wrapper instead
  // asserts the wiring directly: every serialized call on the real client
  // carries an op name, and the mock client's stay unnamed so test
  // infrastructure never pollutes a consumer's observations.
  function serializeCallSites() {
    const source = readFileSync(
      fileURLToPath(new URL("../index.js", import.meta.url)),
      "utf8"
    );
    const sourceFile = ts.createSourceFile(
      "index.js",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );

    const sites = [];
    const visit = (node, enclosingClass) => {
      const scope = ts.isClassDeclaration(node)
        ? (node.name?.text ?? enclosingClass)
        : enclosingClass;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "_serializeWasmCall"
      ) {
        sites.push({ scope, argumentCount: node.arguments.length });
      }
      ts.forEachChild(node, (child) => visit(child, scope));
    };
    visit(sourceFile, null);
    return sites;
  }

  it("passes an op name from every WebClient call site", () => {
    const sites = serializeCallSites().filter((s) => s.scope === "WebClient");
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.map((s) => s.argumentCount)).toEqual(sites.map(() => 2));
  });

  it("passes no op name from the MockWebClient call sites", () => {
    const sites = serializeCallSites().filter(
      (s) => s.scope === "MockWebClient"
    );
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.map((s) => s.argumentCount)).toEqual(sites.map(() => 1));
  });
});

describe("proxy fallthrough observation", () => {
  function makeProxy() {
    const instance = makeHost();
    instance.wasmWebClient = {
      // Classified in READ_METHODS — routed through _serializeWasmCall.
      getAccount: async () => "account",
      // Classified in SYNC_METHODS — bound raw, must stay unobserved.
      setDebugMode: () => "debug-set",
    };
    return createClientProxy(instance);
  }

  it("observes a fallthrough method under its property name", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await expect(makeProxy().getAccount()).resolves.toBe("account");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ op: "getAccount", outcome: "ok" });
  });

  it("leaves raw-bound sync methods unobserved and synchronous", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    const proxy = makeProxy();

    // Positive control: the observer is live for this proxy.
    await proxy.getAccount();
    expect(seen.map((o) => o.op)).toEqual(["getAccount"]);

    // Raw-bound: returns the value itself, not a promise, and emits nothing.
    expect(proxy.setDebugMode()).toBe("debug-set");
    await Promise.resolve();
    expect(seen.map((o) => o.op)).toEqual(["getAccount"]);
  });
});
