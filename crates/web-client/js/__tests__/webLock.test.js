import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withWriteLock } from "../webLock.js";

// ── helpers ───────────────────────────────────────────────────────────────────

let origNavigator;

beforeEach(() => {
  origNavigator = globalThis.navigator;
});

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: origNavigator,
  });
});

function setNavigatorLocks(impl) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: impl } },
  });
}

function disableWebLocks() {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });
}

// ── withWriteLock — no Web Locks fallback ─────────────────────────────────────

describe("withWriteLock — no Web Locks (node fallback)", () => {
  beforeEach(() => {
    disableWebLocks();
  });

  it("runs fn immediately and returns its result", async () => {
    const result = await withWriteLock("store", () => Promise.resolve("done"));
    expect(result).toBe("done");
  });

  it("propagates errors from fn", async () => {
    await expect(
      withWriteLock("store", () => Promise.reject(new Error("fn error")))
    ).rejects.toThrow("fn error");
  });

  it("works without a timeout argument", async () => {
    const result = await withWriteLock("store", () => "value");
    expect(result).toBe("value");
  });
});

// ── withWriteLock — Web Locks path (no timeout) ───────────────────────────────

describe("withWriteLock — Web Locks path (no timeout)", () => {
  it("calls navigator.locks.request and returns fn result", async () => {
    const request = vi.fn().mockImplementation(async (_name, _opts, fn) => {
      return fn();
    });
    setNavigatorLocks(request);

    const result = await withWriteLock("my-store", () => Promise.resolve(42));
    expect(request).toHaveBeenCalledWith(
      "miden-db-my-store",
      { mode: "exclusive" },
      expect.any(Function)
    );
    expect(result).toBe(42);
  });

  it("uses default store name when storeName is falsy", async () => {
    const request = vi.fn().mockImplementation(async (_name, _opts, fn) => fn());
    setNavigatorLocks(request);

    await withWriteLock("", () => "result");
    expect(request).toHaveBeenCalledWith(
      "miden-db-default",
      expect.anything(),
      expect.any(Function)
    );
  });

  it("propagates error thrown from fn via lock", async () => {
    const request = vi.fn().mockImplementation(async (_name, _opts, fn) => fn());
    setNavigatorLocks(request);

    await expect(
      withWriteLock("store", () => {
        throw new Error("lock fn error");
      })
    ).rejects.toThrow("lock fn error");
  });
});

// ── withWriteLock — Web Locks path (with timeout) ─────────────────────────────

describe("withWriteLock — Web Locks path (with timeout)", () => {
  it("calls navigator.locks.request with signal and clears timeout on success", async () => {
    const request = vi.fn().mockImplementation(async (_name, opts, fn) => {
      return fn();
    });
    setNavigatorLocks(request);

    const result = await withWriteLock("store", () => "ok", 1000);
    expect(request).toHaveBeenCalledWith(
      "miden-db-store",
      { mode: "exclusive", signal: expect.any(AbortSignal) },
      expect.any(Function)
    );
    expect(result).toBe("ok");
  });

  it("propagates error from lock request with timeout", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new Error("lock acquisition failed"));
    setNavigatorLocks(request);

    await expect(withWriteLock("store", () => "ok", 500)).rejects.toThrow(
      "lock acquisition failed"
    );
  });
});
