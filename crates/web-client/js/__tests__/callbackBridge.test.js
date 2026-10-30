import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("../../Cargo.toml", () => ({}));
import { WasmWebClient } from "../index.js";
import { CallbackType, WorkerAction } from "../constants.js";
import {
  DEFAULT_CALLBACK_TIMEOUT_MS,
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
    expect(error.message).toBe(
      'sign callback threw {"code":4001} with no message'
    );
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

  it("uses a fallback when a value cannot be converted to text", () => {
    const thrown = {
      message: "",
      toJSON() {
        throw new Error("json conversion failed");
      },
      [Symbol.toPrimitive]() {
        throw new Error("string conversion failed");
      },
    };

    expect(serializeCallbackError(thrown, "sign")).toEqual({
      message: "sign callback threw an unreadable value",
    });
  });

  it("keeps the parent message when the cause cannot be stringified", () => {
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
      cause: { message: "sign callback threw an unreadable cause" },
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
