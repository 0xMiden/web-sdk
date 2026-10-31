import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
vi.mock("../../Cargo.toml", () => ({}));
import { WasmWebClient } from "../index.js";
import { CallbackType, WorkerAction } from "../constants.js";
import {
  DEFAULT_CALLBACK_TIMEOUT_MS,
  appendAuthError,
  callbackTimeoutFor,
  createCallbackForwarder,
  deserializeCallbackError,
  serializeCallbackError,
  validateCallbackTimeoutMs,
} from "../callbackBridge.js";

// ── helpers ───────────────────────────────────────────────────────────────────

// Wires a forwarder to a fake main thread that runs `callback` the way the
// EXECUTE_CALLBACK handler in index.js does, with structuredClone standing in
// for postMessage in both directions.
function bridgeTo(callback, { timeoutMs } = {}) {
  let forwarder;
  forwarder = createCallbackForwarder({
    post: (request) => {
      const { callbackType, args, requestId } = structuredClone(request);
      Promise.resolve()
        .then(() => callback(...args))
        .then(
          (result) => ({
            callbackOk: true,
            callbackResult: result,
            callbackRequestId: requestId,
          }),
          (error) => ({
            callbackOk: false,
            callbackError: serializeCallbackError(error, callbackType),
            callbackRequestId: requestId,
          })
        )
        .then((reply) => forwarder.handleReply(structuredClone(reply)));
    },
    timeoutMs: () => timeoutMs,
  });
  return forwarder;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the production WebClient worker bridge", () => {
  class RecordingWorker {
    static instances = [];

    constructor() {
      this.messages = [];
      this.listeners = new Map();
      RecordingWorker.instances.push(this);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    postMessage(message) {
      this.messages.push(structuredClone(message));
    }

    async emit(data) {
      return this.listeners.get("message")({ data });
    }
  }

  function createClient({ sign, callbackTimeoutMs } = {}) {
    const client = new WasmWebClient(
      "https://rpc.example",
      "https://notes.example",
      undefined,
      "callback-bridge-store",
      undefined,
      undefined,
      sign,
      undefined,
      true,
      undefined,
      "0xfee",
      callbackTimeoutMs
    );
    return { client, worker: RecordingWorker.instances.at(-1) };
  }

  async function initialize(worker) {
    await worker.emit({ loaded: true });
    await Promise.resolve();
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    RecordingWorker.instances = [];
  });

  afterAll(() => {
    delete globalThis.self;
    delete globalThis.__midenWorkerWasm;
  });

  it("posts a successful sign reply from the real handler", async () => {
    vi.stubGlobal("Worker", RecordingWorker);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sign = vi.fn(async () => "signed");
    const { worker } = createClient({ sign, callbackTimeoutMs: 120000 });

    await worker.emit({
      action: WorkerAction.EXECUTE_CALLBACK,
      callbackType: CallbackType.SIGN,
      args: ["pk", "inputs"],
      requestId: "req-ok",
    });

    expect(sign).toHaveBeenCalledWith("pk", "inputs");
    expect(worker.messages).toContainEqual({
      callbackOk: true,
      callbackResult: "signed",
      callbackRequestId: "req-ok",
    });
  });

  it("posts a cloneable failure reply from the real handler", async () => {
    vi.stubGlobal("Worker", RecordingWorker);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { worker } = createClient({
      sign: async () => {
        throw new Error("wallet locked");
      },
      callbackTimeoutMs: 120000,
    });

    await worker.emit({
      action: WorkerAction.EXECUTE_CALLBACK,
      callbackType: CallbackType.SIGN,
      args: ["pk", "inputs"],
      requestId: "req-fail",
    });

    expect(worker.messages).toContainEqual({
      callbackOk: false,
      callbackError: { name: "Error", message: "wallet locked" },
      callbackRequestId: "req-fail",
    });
  });

  it.each([0, 120000, 2147483647])(
    "posts callbackTimeoutMs %s as the last INIT argument",
    async (callbackTimeoutMs) => {
      vi.stubGlobal("Worker", RecordingWorker);
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { worker } = createClient({ sign: () => {}, callbackTimeoutMs });

      await initialize(worker);

      const init = worker.messages.find(
        ({ action }) => action === WorkerAction.INIT
      );
      expect(init.args).toHaveLength(11);
      expect(init.args[0]).toBe("https://rpc.example");
      expect(init.args[4]).toBe(false);
      expect(init.args[5]).toBe(false);
      expect(init.args[6]).toBe(true);
      expect(init.args[9]).toBe("0xfee");
      expect(init.args[10]).toBe(callbackTimeoutMs);
    }
  );

  it.each([-1, Number.NaN, 2147483648])(
    "rejects invalid callbackTimeoutMs %s in the constructor before creating a worker",
    (callbackTimeoutMs) => {
      vi.stubGlobal("Worker", RecordingWorker);
      vi.spyOn(console, "log").mockImplementation(() => {});

      expect(() => createClient({ sign: () => {}, callbackTimeoutMs })).toThrow(
        "callbackTimeoutMs must be a non-negative finite number no greater than 2147483647"
      );
      expect(RecordingWorker.instances).toHaveLength(0);
    }
  );
});

// ── failed callbacks (#316) ───────────────────────────────────────────────────

describe("a callback that throws", () => {
  it("rejects with a thrown string as the message", async () => {
    const forwarder = bridgeTo(() => {
      throw "user rejected";
    });

    await expect(forwarder.forward("sign", [])).rejects.toMatchObject({
      message: "user rejected",
    });
  });

  it("rejects with the code of a thrown object that has no message", async () => {
    const forwarder = bridgeTo(() => {
      throw { code: 4001 };
    });

    const error = await forwarder.forward("sign", []).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(4001);
    expect(error.message).toBe("sign callback threw an object with no message");
  });

  it("does not include unrelated thrown object fields in the error message", async () => {
    const forwarder = bridgeTo(() => {
      throw { code: 4001, privateData: "must not leak" };
    });

    const error = await forwarder.forward("sign", []).catch((e) => e);

    expect(error.code).toBe(4001);
    expect(error.message).toBe("sign callback threw an object with no message");
    expect(error.message).not.toContain("must not leak");
  });

  it("rejects when the callback throws null", async () => {
    const forwarder = bridgeTo(() => {
      throw null;
    });

    await expect(forwarder.forward("getKey", [])).rejects.toMatchObject({
      message: "getKey callback threw null",
    });
  });

  it("rejects when the callback throws undefined", async () => {
    const forwarder = bridgeTo(() => {
      throw undefined;
    });

    await expect(forwarder.forward("insertKey", [])).rejects.toMatchObject({
      message: "insertKey callback threw undefined",
    });
  });

  it("rejects for an Error with an empty message, keeping its name and code", async () => {
    const forwarder = bridgeTo(() => {
      throw Object.assign(new TypeError(""), { code: "LOCKED" });
    });

    const error = await forwarder.forward("sign", []).catch((e) => e);

    expect(error.name).toBe("TypeError");
    expect(error.code).toBe("LOCKED");
    expect(error.message).toBe("sign callback threw TypeError with no message");
  });

  it("keeps an Error's message, name, code, reason and cause", async () => {
    const forwarder = bridgeTo(async () => {
      throw Object.assign(new Error("wallet locked"), {
        name: "WalletError",
        code: "E_LOCKED",
        reason: "locked",
        cause: new Error("vault sealed"),
      });
    });

    const error = await forwarder.forward("sign", []).catch((e) => e);

    expect(error).toMatchObject({
      name: "WalletError",
      message: "wallet locked",
      code: "E_LOCKED",
      reason: "locked",
    });
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause.message).toBe("vault sealed");
  });

  it("rejects when a sign callback throws an error with a circular cause", async () => {
    vi.useFakeTimers();
    const error = new Error("wallet locked");
    error.cause = error;
    const forwarder = bridgeTo(
      () => {
        throw error;
      },
      { timeoutMs: 10 }
    );

    const result = forwarder.forward("sign", []).catch((error) => error);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toMatchObject({
      message: "wallet locked",
      cause: { message: "sign callback threw a circular cause" },
    });
  });

  it("rejects when two callback errors have a circular cause", async () => {
    vi.useFakeTimers();
    const outer = new Error("wallet locked");
    const inner = new Error("vault sealed");
    outer.cause = inner;
    inner.cause = outer;
    const forwarder = bridgeTo(
      () => {
        throw outer;
      },
      { timeoutMs: 10 }
    );

    const result = forwarder.forward("sign", []).catch((error) => error);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toMatchObject({
      message: "wallet locked",
      cause: {
        message: "vault sealed",
        cause: { message: "sign callback threw a circular cause" },
      },
    });
  });

  it("replies with a fallback when all thrown value properties are unreadable", async () => {
    vi.useFakeTimers();
    const thrown = Object.defineProperties(
      {},
      {
        name: {
          get() {
            throw new Error("name unreadable");
          },
        },
        message: {
          get() {
            throw new Error("message unreadable");
          },
        },
        code: {
          get() {
            throw new Error("code unreadable");
          },
        },
        reason: {
          get() {
            throw new Error("reason unreadable");
          },
        },
        cause: {
          get() {
            throw new Error("cause unreadable");
          },
        },
      }
    );
    const forwarder = bridgeTo(
      () => {
        throw thrown;
      },
      { timeoutMs: 10 }
    );

    const result = forwarder.forward("sign", []).catch((error) => error);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toMatchObject({
      message: "sign callback threw an unreadable value",
    });
    expect(() =>
      structuredClone(serializeCallbackError(thrown, "sign"))
    ).not.toThrow();
  });

  it("keeps a readable message when later error properties throw", () => {
    const thrown = Object.defineProperties(
      { message: "wallet locked" },
      {
        code: {
          get() {
            throw new Error("code unreadable");
          },
        },
        cause: {
          get() {
            throw new Error("cause unreadable");
          },
        },
      }
    );

    const serialized = serializeCallbackError(thrown, "sign");

    expect(serialized).toEqual({ message: "wallet locked" });
    expect(() => structuredClone(serialized)).not.toThrow();
  });

  it("does not invoke coercion hooks on thrown objects", () => {
    const toJSON = vi.fn(() => {
      throw new Error("json conversion failed");
    });
    const toPrimitive = vi.fn(() => {
      throw new Error("string conversion failed");
    });
    const thrown = {
      message: "",
      toJSON,
      [Symbol.toPrimitive]: toPrimitive,
    };

    expect(serializeCallbackError(thrown, "sign")).toEqual({
      message: "sign callback threw an object with no message",
    });
    expect(toJSON).not.toHaveBeenCalled();
    expect(toPrimitive).not.toHaveBeenCalled();
  });

  it("keeps the parent message and sanitizes an object cause without a message", () => {
    const thrown = Object.assign(new Error("wallet locked"), {
      name: "WalletError",
      code: "E_LOCKED",
      cause: Object.create(null),
    });

    const serialized = serializeCallbackError(thrown, "sign");

    expect(serialized).toEqual({
      name: "WalletError",
      message: "wallet locked",
      code: "E_LOCKED",
      cause: { message: "sign callback threw an object with no message" },
    });
    expect(() => structuredClone(serialized)).not.toThrow();
  });

  it("drops a code that cannot be structured-cloned instead of failing the reply", () => {
    const serialized = serializeCallbackError(
      { message: "no", code: () => {} },
      "sign"
    );

    expect(() => structuredClone(serialized)).not.toThrow();
    expect(serialized).toEqual({ message: "no" });
  });
});

describe("a callback that succeeds", () => {
  it("resolves with its result, including a falsy one", async () => {
    await expect(bridgeTo(() => undefined).forward("getKey", [])).resolves.toBe(
      undefined
    );
    await expect(
      bridgeTo(async () => new Uint8Array([1, 2])).forward("sign", [])
    ).resolves.toEqual(new Uint8Array([1, 2]));
  });
});

// ── time limits (#316) ────────────────────────────────────────────────────────

describe("callback time limits", () => {
  it("lets an unset sign wait past 30 seconds", async () => {
    vi.useFakeTimers();
    const forwarder = bridgeTo(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(new Uint8Array([7])), 45_000)
        )
    );

    const result = forwarder.forward("sign", []);
    await vi.advanceTimersByTimeAsync(45_000);

    await expect(result).resolves.toEqual(new Uint8Array([7]));
  });

  it("keeps the 30 second limit for an unset getKey", async () => {
    vi.useFakeTimers();
    const forwarder = bridgeTo(() => new Promise(() => {}));

    const result = forwarder.forward("getKey", []);
    const settled = expect(result).rejects.toThrow(/timed out after 30000ms$/);
    await vi.advanceTimersByTimeAsync(DEFAULT_CALLBACK_TIMEOUT_MS);

    await settled;
  });

  it("applies a configured limit to sign", async () => {
    vi.useFakeTimers();
    const forwarder = bridgeTo(() => new Promise(() => {}), {
      timeoutMs: 5_000,
    });

    const result = forwarder.forward("sign", []);
    const settled = expect(result).rejects.toThrow(/timed out after 5000ms$/);
    await vi.advanceTimersByTimeAsync(5_000);

    await settled;
  });

  it("ignores a reply that arrives after the limit", async () => {
    vi.useFakeTimers();
    const forwarder = bridgeTo(
      () => new Promise((resolve) => setTimeout(() => resolve("late"), 2_000)),
      { timeoutMs: 1_000 }
    );

    const result = forwarder.forward("getKey", []).catch((e) => e);
    await vi.advanceTimersByTimeAsync(2_000);

    expect((await result).message).toMatch(/timed out after 1000ms$/);
  });

  it("consumes a reply that arrives after its timeout", async () => {
    vi.useFakeTimers();
    let callbackRequestId;
    const forwarder = createCallbackForwarder({
      post: (request) => {
        callbackRequestId = request.requestId;
      },
      timeoutMs: () => 1_000,
    });

    const result = forwarder.forward("getKey", []);
    const timedOut = expect(result).rejects.toThrow(/timed out after 1000ms$/);
    await vi.advanceTimersByTimeAsync(1_000);
    await timedOut;

    expect(
      forwarder.handleReply({
        callbackRequestId,
        callbackOk: true,
        callbackResult: "late",
      })
    ).toBe(true);
    await expect(result).rejects.toThrow(/timed out after 1000ms$/);
  });

  it("maps callbackTimeoutMs to a limit for each callback", () => {
    expect(callbackTimeoutFor("sign", undefined)).toBeUndefined();
    expect(callbackTimeoutFor("getKey", undefined)).toBe(30_000);
    expect(callbackTimeoutFor("insertKey", undefined)).toBe(30_000);
    expect(callbackTimeoutFor("sign", 0)).toBeUndefined();
    expect(callbackTimeoutFor("getKey", 0)).toBeUndefined();
    expect(callbackTimeoutFor("sign", 0.5)).toBe(1);
    expect(callbackTimeoutFor("sign", 120_000)).toBe(120_000);
    expect(callbackTimeoutFor("insertKey", 120_000)).toBe(120_000);
  });

  it("rejects an invalid callbackTimeoutMs", () => {
    expect(validateCallbackTimeoutMs(undefined)).toBeUndefined();
    expect(validateCallbackTimeoutMs(0)).toBe(0);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1000"]) {
      expect(() => validateCallbackTimeoutMs(bad)).toThrow(TypeError);
    }
  });

  it("reports non-finite numeric callbackTimeoutMs values accurately", () => {
    for (const [bad, value] of [
      [Number.NaN, "NaN"],
      [Number.POSITIVE_INFINITY, "Infinity"],
      [Number.NEGATIVE_INFINITY, "-Infinity"],
    ]) {
      expect(() => validateCallbackTimeoutMs(bad)).toThrow(
        `callbackTimeoutMs must be a non-negative finite number no greater than 2147483647, got ${value}`
      );
    }
  });

  it("rejects a callbackTimeoutMs above the timer limit", () => {
    expect(() => validateCallbackTimeoutMs(2_147_483_648)).toThrow(
      "callbackTimeoutMs must be a non-negative finite number no greater than 2147483647, got 2147483648"
    );
    expect(validateCallbackTimeoutMs(2_147_483_647)).toBe(2_147_483_647);
  });

  it("passes the largest callback timeout to timers for every callback", () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");

    for (const callbackType of ["sign", "getKey", "insertKey"]) {
      const forwarder = createCallbackForwarder({
        post: () => {},
        timeoutMs: () => 2_147_483_647,
      });
      forwarder.forward(callbackType, []);
    }

    expect(timer).toHaveBeenCalledTimes(3);
    for (const [, delay] of timer.mock.calls) {
      expect(delay).toBe(2_147_483_647);
    }
  });

  it("binds INIT timeouts and settles worker callback replies", async () => {
    vi.resetModules();
    const messages = [];
    let callbacks;

    class WorkerWebClient {
      async createClientWithExternalKeystore(
        _rpcUrl,
        _noteTransportUrl,
        _seed,
        _storeName,
        _feeFaucetId,
        getKey,
        insertKey,
        sign
      ) {
        callbacks = { getKey, insertKey, sign };
      }
    }

    globalThis.self = {
      postMessage(message) {
        messages.push(structuredClone(message));
      },
    };
    globalThis.__midenWorkerWasm = {
      WebClient: WorkerWebClient,
      setupLogging() {},
    };

    await import("../workers/web-client-methods-worker.js");
    expect(messages).toContainEqual({ loaded: true });

    globalThis.self.onmessage({
      data: {
        action: WorkerAction.INIT,
        args: [
          "https://rpc.example",
          undefined,
          undefined,
          "worker-callback-bridge-store",
          true,
          true,
          true,
          null,
          1,
          "0xfee",
          1000,
        ],
      },
    });
    await vi.waitFor(() => expect(messages).toContainEqual({ ready: true }));

    const successfulReply = callbacks.sign("pk-success", "inputs");
    const successRequest = messages.findLast(
      ({ action }) => action === WorkerAction.EXECUTE_CALLBACK
    );
    globalThis.self.onmessage({
      data: {
        callbackOk: true,
        callbackResult: "signed",
        callbackRequestId: successRequest.requestId,
      },
    });
    await expect(successfulReply).resolves.toBe("signed");

    const rejectedReply = callbacks.sign("pk-rejected", "inputs");
    const rejectedRequest = messages.findLast(
      ({ action }) => action === WorkerAction.EXECUTE_CALLBACK
    );
    globalThis.self.onmessage({
      data: {
        callbackOk: false,
        callbackError: { message: "wallet locked" },
        callbackRequestId: rejectedRequest.requestId,
      },
    });
    await expect(rejectedReply).rejects.toThrow("wallet locked");

    vi.useFakeTimers();
    const timeoutRequest = async (callbackType, callback) => {
      const pending = callback();
      const request = messages.findLast(
        (message) =>
          message.action === WorkerAction.EXECUTE_CALLBACK &&
          message.callbackType === callbackType
      );
      const rejection = expect(pending).rejects.toThrow(
        new RegExp(`Callback ${callbackType}-.+ timed out after 1000ms`)
      );
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
      return request;
    };

    const lateRequest = await timeoutRequest("sign", () =>
      callbacks.sign("pk-timeout", "inputs")
    );
    await timeoutRequest("getKey", () => callbacks.getKey("pk"));
    await timeoutRequest("insertKey", () => callbacks.insertKey("pk", "key"));

    globalThis.self.onmessage({
      data: {
        callbackOk: true,
        callbackResult: "late",
        callbackRequestId: lateRequest.requestId,
      },
    });
    expect(
      messages.some(
        ({ error }) => error?.message === "Unsupported action: undefined"
      )
    ).toBe(false);
  });
});

describe("handleReply", () => {
  it("consumes stale callback replies but leaves ordinary messages alone", () => {
    const forwarder = createCallbackForwarder({
      post: () => {},
      timeoutMs: () => undefined,
    });

    expect(forwarder.handleReply({ action: "init" })).toBe(false);
    expect(
      forwarder.handleReply({
        callbackRequestId: "sign-unknown",
        callbackOk: true,
      })
    ).toBe(true);
  });
});

describe("deserializeCallbackError", () => {
  it("returns a plain Error when only a message was sent", () => {
    const error = deserializeCallbackError({ message: "boom" });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("Error");
    expect(error).not.toHaveProperty("code");
  });
});

describe("WebClient.createClient callback timeout", () => {
  it("rejects an invalid timeout before loading WASM", async () => {
    await expect(
      WasmWebClient.createClient(
        "https://rpc.testnet.miden.io",
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        2147483648
      )
    ).rejects.toThrow(
      "callbackTimeoutMs must be a non-negative finite number no greater than 2147483647"
    );
  });
});

describe("transaction authentication error detail", () => {
  it.each(["wallet locked", new Error("wallet locked")])(
    "appends readable callback detail to the native error",
    (detail) => {
      expect(appendAuthError("authentication failed", detail)).toBe(
        "authentication failed: wallet locked"
      );
    }
  );

  it("does not duplicate callback detail already in the error", () => {
    expect(
      appendAuthError("authentication failed: wallet locked", "wallet locked")
    ).toBe("authentication failed: wallet locked");
  });

  it.each([
    null,
    undefined,
    "",
    4001,
    { privateData: "must not leak" },
    new Error(""),
  ])("ignores callback values without a readable message", (detail) => {
    expect(appendAuthError("authentication failed", detail)).toBe(
      "authentication failed"
    );
  });

  it("ignores a callback value whose message getter throws", () => {
    const detail = Object.defineProperty({}, "message", {
      get() {
        throw new Error("must not leak");
      },
    });
    expect(appendAuthError("authentication failed", detail)).toBe(
      "authentication failed"
    );
  });
});

describe("executeTransaction auth error boundaries", () => {
  it.each(["wallet locked", new Error("wallet locked")])(
    "enriches direct errors while preserving the native code and identity",
    async (detail) => {
      const error = Object.assign(new Error("authentication failed"), {
        code: "AUTH",
      });
      const wasmWebClient = {
        executeTransaction: async () => {
          throw error;
        },
        lastAuthError: () => detail,
      };
      const client = Object.assign(Object.create(WasmWebClient.prototype), {
        worker: null,
        wasmWebClient,
        getWasmWebClient: async () => wasmWebClient,
        _withInnerLockDepth: 0,
        _wasmCallChain: Promise.resolve(),
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(client.executeTransaction({}, {})).rejects.toBe(error);
        expect(error.message).toBe("authentication failed: wallet locked");
        expect(error.code).toBe("AUTH");
      } finally {
        log.mockRestore();
      }
    }
  );

  it("enriches worker errors while preserving the native code", async () => {
    vi.resetModules();
    const messages = [];
    class WorkerWebClient {
      async createClient() {}
      async executeTransaction() {
        throw Object.assign(new Error("authentication failed"), {
          code: "AUTH",
        });
      }
      lastAuthError() {
        return "wallet locked";
      }
    }
    globalThis.self = {
      postMessage: (message) => messages.push(structuredClone(message)),
    };
    globalThis.__midenWorkerWasm = {
      WebClient: WorkerWebClient,
      setupLogging() {},
      AccountId: { fromHex: (value) => value },
      TransactionRequest: {
        deserialize: (value) => {
          if (value[0] === 255) throw new Error("invalid transaction request");
          return value;
        },
      },
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await import("../workers/web-client-methods-worker.js");
      globalThis.self.onmessage({
        data: { action: WorkerAction.INIT, args: [] },
      });
      await vi.waitFor(() => expect(messages).toContainEqual({ ready: true }));
      globalThis.self.onmessage({
        data: {
          action: WorkerAction.CALL_METHOD,
          methodName: "executeTransaction",
          requestId: "tx-auth",
          args: ["account", new Uint8Array()],
        },
      });
      await vi.waitFor(() =>
        expect(
          messages.find((message) => message.requestId === "tx-auth")
        ).toMatchObject({
          error: {
            message: "authentication failed: wallet locked",
            code: "AUTH",
          },
        })
      );
      globalThis.self.onmessage({
        data: {
          action: WorkerAction.CALL_METHOD,
          methodName: "executeTransaction",
          requestId: "tx-invalid",
          args: ["account", new Uint8Array([255])],
        },
      });
      await vi.waitFor(() =>
        expect(
          messages.find((message) => message.requestId === "tx-invalid")
        ).toMatchObject({ error: { message: "invalid transaction request" } })
      );
    } finally {
      log.mockRestore();
      delete globalThis.self;
      delete globalThis.__midenWorkerWasm;
    }
  });
});
