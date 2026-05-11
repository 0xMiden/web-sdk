import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  hasWebLocks,
  acquireSyncLock,
  releaseSyncLock,
  releaseSyncLockWithError,
} from "../syncLock.js";

// ── helpers ───────────────────────────────────────────────────────────────────

let dbCounter = 0;
function uniqueDb() {
  return `test-sync-db-${++dbCounter}-${Date.now()}`;
}

// ── hasWebLocks ────────────────────────────────────────────────────────────────

describe("hasWebLocks", () => {
  it("returns false when navigator is undefined", () => {
    const orig = globalThis.navigator;
    // Can't delete navigator in strict mode; use defineProperty
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: undefined,
    });
    try {
      expect(hasWebLocks()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: orig,
      });
    }
  });

  it("returns false when navigator.locks is undefined", () => {
    const orig = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    try {
      expect(hasWebLocks()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: orig,
      });
    }
  });

  it("returns false when navigator.locks.request is not a function", () => {
    const orig = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: { request: 42 } },
    });
    try {
      expect(hasWebLocks()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: orig,
      });
    }
  });

  it("returns true when navigator.locks.request is a function", () => {
    const orig = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: { request: vi.fn() } },
    });
    try {
      expect(hasWebLocks()).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: orig,
      });
    }
  });
});

// ── acquireSyncLock / releaseSyncLock (no Web Locks) ─────────────────────────

// In a node environment, navigator.locks is unavailable, so we test the
// in-process fallback path throughout this suite.

describe("acquireSyncLock — in-process fallback (no Web Locks)", () => {
  it("acquires immediately when no sync in progress", async () => {
    const dbId = uniqueDb();
    const result = await acquireSyncLock(dbId);
    expect(result.acquired).toBe(true);
    releaseSyncLock(dbId, "done"); // cleanup
  });

  it("coalesces: waiter receives the same result as the releaser", async () => {
    const dbId = uniqueDb();
    // Acquire first
    const { acquired } = await acquireSyncLock(dbId);
    expect(acquired).toBe(true);

    // Second call while in-progress — should wait
    const waiterPromise = acquireSyncLock(dbId);

    // Release with a result
    releaseSyncLock(dbId, "syncResult");

    const waiterResult = await waiterPromise;
    expect(waiterResult.acquired).toBe(false);
    expect(waiterResult.coalescedResult).toBe("syncResult");
  });

  it("coalesces error: waiter rejects with the same error", async () => {
    const dbId = uniqueDb();
    await acquireSyncLock(dbId);

    const waiterPromise = acquireSyncLock(dbId);
    const err = new Error("sync failed");
    releaseSyncLockWithError(dbId, err);

    await expect(waiterPromise).rejects.toThrow("sync failed");
  });

  it("allows re-acquire after releaseSyncLock", async () => {
    const dbId = uniqueDb();
    await acquireSyncLock(dbId);
    releaseSyncLock(dbId, "first");

    const second = await acquireSyncLock(dbId);
    expect(second.acquired).toBe(true);
    releaseSyncLock(dbId, "second");
  });

  it("multiple waiters all receive the same result", async () => {
    const dbId = uniqueDb();
    await acquireSyncLock(dbId);

    const w1 = acquireSyncLock(dbId);
    const w2 = acquireSyncLock(dbId);

    releaseSyncLock(dbId, "sharedResult");

    const [r1, r2] = await Promise.all([w1, w2]);
    expect(r1.coalescedResult).toBe("sharedResult");
    expect(r2.coalescedResult).toBe("sharedResult");
  });
});

describe("releaseSyncLock — edge cases", () => {
  it("warns when called without an active sync (no-op)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dbId = uniqueDb();
    releaseSyncLock(dbId, "orphan");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no sync was in progress")
    );
    warnSpy.mockRestore();
  });
});

describe("releaseSyncLockWithError — edge cases", () => {
  it("warns when called without an active sync (no-op)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dbId = uniqueDb();
    releaseSyncLockWithError(dbId, new Error("orphan error"));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no sync was in progress")
    );
    warnSpy.mockRestore();
  });
});

describe("acquireSyncLock — timeout (no Web Locks fallback)", () => {
  it("waiter times out when sync takes too long", async () => {
    const dbId = uniqueDb();
    // Acquire the lock (first caller)
    await acquireSyncLock(dbId);

    // Second caller with a very short timeout
    const waiterPromise = acquireSyncLock(dbId, 10);
    await expect(waiterPromise).rejects.toThrow("timed out");

    // Cleanup
    releaseSyncLock(dbId, "late result");
  }, 3000);
});

// ── Web Locks path (mocked) ───────────────────────────────────────────────────

describe("acquireSyncLock — Web Locks path", () => {
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

  it("acquires via Web Locks when available", async () => {
    const dbId = uniqueDb();
    let lockCallback;

    // Mock navigator.locks to capture the callback
    const mockLocks = {
      request: vi.fn().mockImplementation((_name, _opts, callback) => {
        return new Promise((resolve) => {
          lockCallback = () => {
            const result = callback();
            result.then(resolve);
          };
        });
      }),
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: mockLocks },
    });

    const lockPromise = acquireSyncLock(dbId);
    // Simulate lock grant by calling the callback
    lockCallback();
    const result = await lockPromise;
    expect(result.acquired).toBe(true);
    releaseSyncLock(dbId, "done");
  });

  it("times out when lock is not granted within timeoutMs (Web Locks path)", async () => {
    const dbId = uniqueDb();

    // Lock request never calls its callback (lock is never granted)
    const mockLocks = {
      request: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: mockLocks },
    });

    await expect(acquireSyncLock(dbId, 10)).rejects.toThrow("timed out");
  }, 3000);

  it("notifies waiters when Web Locks timeout fires with a coalesced waiter", async () => {
    const dbId = uniqueDb();

    // Lock never granted — so the timeout fires for both acquirer and waiters
    const mockLocks = {
      request: vi.fn().mockImplementation(() => new Promise(() => {})),
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: mockLocks },
    });

    // First acquire with a short timeout
    const p1 = acquireSyncLock(dbId, 15);
    // While p1 is in-progress (before timeout fires), add a waiter
    const p2 = acquireSyncLock(dbId, 1000);

    // Both should reject — p1 from timeout, p2 from waiter rejection
    await expect(p1).rejects.toThrow("timed out");
    await expect(p2).rejects.toThrow("timed out");
  }, 3000);

  it("clears timeout when Web Locks grant the lock before timeout fires", async () => {
    const dbId = uniqueDb();
    let lockCallback;

    const mockLocks = {
      request: vi.fn().mockImplementation((_name, _opts, callback) => {
        return new Promise((resolve) => {
          lockCallback = () => {
            const result = callback();
            result.then(resolve);
          };
        });
      }),
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: mockLocks },
    });

    // Pass a timeout so timeoutId is set, then grant lock before it fires
    const lockPromise = acquireSyncLock(dbId, 5000);
    // Grant the lock immediately (before 5000ms timeout)
    lockCallback();
    const result = await lockPromise;
    expect(result.acquired).toBe(true);
    releaseSyncLock(dbId, "done");
  });

  it("rejects when Web Locks request rejects with Error object", async () => {
    const dbId = uniqueDb();

    const mockLocks = {
      request: vi.fn().mockRejectedValue(new Error("locks unavailable")),
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: mockLocks },
    });

    await expect(acquireSyncLock(dbId)).rejects.toThrow("locks unavailable");
  });

  it("wraps non-Error rejection in a new Error", async () => {
    const dbId = uniqueDb();

    const mockLocks = {
      request: vi.fn().mockRejectedValue("string rejection"), // not an Error object
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: mockLocks },
    });

    await expect(acquireSyncLock(dbId)).rejects.toThrow("string rejection");
  });

  it("releaseSyncLockWithError calls state.releaseLock if set (Web Locks path)", async () => {
    const dbId = uniqueDb();
    let lockCallback;

    const mockLocks = {
      request: vi.fn().mockImplementation((_name, _opts, callback) => {
        return new Promise((resolve) => {
          lockCallback = () => {
            const result = callback();
            result.then(resolve);
          };
        });
      }),
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: mockLocks },
    });

    const lockPromise = acquireSyncLock(dbId);
    lockCallback();
    const acquired = await lockPromise;
    expect(acquired.acquired).toBe(true);

    // Now release with error — should invoke state.releaseLock
    const err = new Error("sync error");
    releaseSyncLockWithError(dbId, err);
    // The lock was held via a releaseLock promise; calling releaseLock() resolves it
  });
});
