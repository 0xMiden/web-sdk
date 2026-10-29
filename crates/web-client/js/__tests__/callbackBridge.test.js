import { describe, it, expect, vi, afterEach } from "vitest";
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
});

describe("handleReply", () => {
  it("returns false for a message that answers no pending callback", () => {
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
    ).toBe(false);
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
