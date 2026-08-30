import { describe, it, expect } from "vitest";
import { CallbackType } from "../constants.js";
import {
  serializeCallbackFailure,
  deserializeCallbackFailure,
  resolveCallbackTimeoutMs,
} from "../callback-bridge.js";

describe("serializeCallbackFailure / deserializeCallbackFailure", () => {
  it("preserves a string throw", () => {
    const serialized = serializeCallbackFailure("user rejected");
    expect(serialized).toEqual({ name: "Error", message: "user rejected" });
    const err = deserializeCallbackFailure(serialized);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("user rejected");
  });

  it("preserves wallet-style { code } objects without a message", () => {
    const serialized = serializeCallbackFailure({ code: 4001 });
    expect(serialized.code).toBe(4001);
    expect(serialized.message).toContain("4001");
    const err = deserializeCallbackFailure(serialized);
    expect(err.code).toBe(4001);
  });

  it("preserves Error name, message, and code", () => {
    const original = new Error("declined");
    original.name = "UserRejectedRequestError";
    original.code = 4001;
    const err = deserializeCallbackFailure(serializeCallbackFailure(original));
    expect(err.name).toBe("UserRejectedRequestError");
    expect(err.message).toBe("declined");
    expect(err.code).toBe(4001);
  });

  it("does not treat an empty Error.message as success payload", () => {
    const serialized = serializeCallbackFailure(new Error(""));
    expect(serialized.message).toBe("");
    expect(serialized.name).toBe("Error");
  });
});

describe("resolveCallbackTimeoutMs", () => {
  it("defaults to 30s for key ops and none for sign", () => {
    expect(resolveCallbackTimeoutMs(undefined, CallbackType.GET_KEY)).toBe(
      30_000
    );
    expect(resolveCallbackTimeoutMs(undefined, CallbackType.INSERT_KEY)).toBe(
      30_000
    );
    expect(resolveCallbackTimeoutMs(undefined, CallbackType.SIGN)).toBeNull();
  });

  it("applies an explicit ceiling to every callback", () => {
    expect(resolveCallbackTimeoutMs(120_000, CallbackType.SIGN)).toBe(120_000);
    expect(resolveCallbackTimeoutMs(5_000, CallbackType.GET_KEY)).toBe(5_000);
  });

  it("disables timeouts when configured null or 0", () => {
    expect(resolveCallbackTimeoutMs(null, CallbackType.GET_KEY)).toBeNull();
    expect(resolveCallbackTimeoutMs(0, CallbackType.SIGN)).toBeNull();
  });
});
