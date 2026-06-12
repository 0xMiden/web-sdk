import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hasWebLocks, withSyncLock } from "../syncLock.js";

// ── helpers ───────────────────────────────────────────────────────────────────

let dbCounter = 0;
function uniqueDb() {
  return `test-sync-db-${++dbCounter}-${Date.now()}`;
}

// ── hasWebLocks ────────────────────────────────────────────────────────────────

describe("hasWebLocks", () => {
  it("returns false when navigator is undefined", () => {
    const orig = globalThis.navigator;
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
      value: { locks: { request: () => {} } },
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

// ── withSyncLock — Web-Locks-unavailable path ─────────────────────────────────
//
// In the node-test env, `navigator` is undefined, so `hasWebLocks()` returns
// false and `withSyncLock` runs `fn` directly (relying on the WASM-level
// mutex to serialize across methods within the tab). These tests cover that
// branch; the Web-Locks branch is exercised by the Playwright integration
// suite under `crates/web-client/test/sync_lock.test.ts`.

describe("withSyncLock — in-process fallback (no Web Locks)", () => {
  beforeEach(() => {
    // Sanity check: vitest runs in node, navigator is absent or stripped of
    // navigator.locks. If a future config change breaks this assumption,
    // these tests need to mock navigator.locks to remain in-process.
    expect(hasWebLocks()).toBe(false);
  });

  it("runs fn and resolves with its result", async () => {
    const dbId = uniqueDb();
    const result = await withSyncLock(dbId, "syncState", async () => "ok");
    expect(result).toBe("ok");
  });

  it("propagates fn rejections to the caller", async () => {
    const dbId = uniqueDb();
    const err = new Error("boom");
    await expect(
      withSyncLock(dbId, "syncState", async () => {
        throw err;
      })
    ).rejects.toBe(err);
  });

  it("coalesces concurrent calls on the same (dbId, methodId): all share one fn invocation", async () => {
    const dbId = uniqueDb();
    const fn = vi.fn(async () => "shared");

    const [a, b, c] = await Promise.all([
      withSyncLock(dbId, "syncState", fn),
      withSyncLock(dbId, "syncState", fn),
      withSyncLock(dbId, "syncState", fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual(["shared", "shared", "shared"]);
  });

  it("coalesces error: concurrent waiters all reject with the same error", async () => {
    const dbId = uniqueDb();
    const err = new Error("shared-fail");
    const fn = vi.fn(async () => {
      throw err;
    });

    const results = await Promise.allSettled([
      withSyncLock(dbId, "syncState", fn),
      withSyncLock(dbId, "syncState", fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect(r.reason).toBe(err);
    }
  });

  it("clears the in-flight slot after fn resolves: a subsequent call invokes fn fresh", async () => {
    const dbId = uniqueDb();
    const fn = vi.fn(async () => "ok");

    await withSyncLock(dbId, "syncState", fn);
    await withSyncLock(dbId, "syncState", fn);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("clears the in-flight slot after fn rejects: a subsequent call invokes fn fresh", async () => {
    const dbId = uniqueDb();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockResolvedValueOnce("second");

    await expect(withSyncLock(dbId, "syncState", fn)).rejects.toThrow("first");
    await expect(withSyncLock(dbId, "syncState", fn)).resolves.toBe("second");

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce calls with different methodIds on the same dbId", async () => {
    const dbId = uniqueDb();
    const fnA = vi.fn(async () => "A");
    const fnB = vi.fn(async () => "B");

    const [a, b] = await Promise.all([
      withSyncLock(dbId, "syncState", fnA),
      withSyncLock(dbId, "syncNoteTransport", fnB),
    ]);

    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
    expect(a).toBe("A");
    expect(b).toBe("B");
  });

  it("serializes calls with different methodIds on the same dbId (no overlap)", async () => {
    // Browser WebClient uses a synchronous RefCell, so overlapping
    // cross-method borrows would throw the "recursive use" aliasing error.
    // Without Web Locks we serialize per-dbId via the in-process chain.
    const dbId = uniqueDb();
    const events = [];
    let releaseA;
    const gateA = new Promise((r) => (releaseA = r));

    const fnA = vi.fn(async () => {
      events.push("start-A");
      await gateA;
      events.push("finish-A");
      return "A";
    });
    const fnB = vi.fn(async () => {
      events.push("start-B");
      events.push("finish-B");
      return "B";
    });

    const pA = withSyncLock(dbId, "syncState", fnA);
    const pB = withSyncLock(dbId, "syncNoteTransport", fnB);

    // Yield enough microtasks for fnA to enter; fnB must still be queued.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(events).toEqual(["start-A"]);

    releaseA();
    await Promise.all([pA, pB]);

    expect(events).toEqual(["start-A", "finish-A", "start-B", "finish-B"]);
  });

  it("runs the next queued call after a prior cross-method call rejects", async () => {
    const dbId = uniqueDb();
    const events = [];
    const fnA = vi.fn(async () => {
      events.push("A");
      throw new Error("A-fail");
    });
    const fnB = vi.fn(async () => {
      events.push("B");
      return "B";
    });

    const pA = withSyncLock(dbId, "syncState", fnA);
    const pB = withSyncLock(dbId, "syncNoteTransport", fnB);

    await expect(pA).rejects.toThrow("A-fail");
    await expect(pB).resolves.toBe("B");
    expect(events).toEqual(["A", "B"]);
  });

  it("does not coalesce calls with the same methodId on different dbIds", async () => {
    const dbA = uniqueDb();
    const dbB = uniqueDb();
    const fn = vi.fn(async () => "ok");

    await Promise.all([
      withSyncLock(dbA, "syncState", fn),
      withSyncLock(dbB, "syncState", fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("supports multiple waiters: all receive the same resolved value", async () => {
    const dbId = uniqueDb();

    let resolveFn;
    const gate = new Promise((r) => (resolveFn = r));
    const fn = vi.fn(() => gate);

    const p1 = withSyncLock(dbId, "syncState", fn);
    const p2 = withSyncLock(dbId, "syncState", fn);
    const p3 = withSyncLock(dbId, "syncState", fn);

    resolveFn("settled");

    const [a, b, c] = await Promise.all([p1, p2, p3]);
    expect([a, b, c]).toEqual(["settled", "settled", "settled"]);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── withSyncLock — Web-Locks path ─────────────────────────────────────────────
//
// Mock navigator.locks.request to verify withSyncLock requests an exclusive
// lock on the right name and runs fn under that lock.

describe("withSyncLock — Web-Locks path", () => {
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

  function installLocksMock(impl) {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: { request: impl } },
    });
  }

  it("requests an exclusive lock named 'miden-sync-<dbId>' and runs fn under it", async () => {
    const dbId = uniqueDb();
    const calls = [];
    installLocksMock(async (name, opts, fn) => {
      calls.push({ name, opts });
      return fn();
    });

    const result = await withSyncLock(dbId, "syncState", async () => "ok");

    expect(result).toBe("ok");
    expect(calls).toEqual([
      { name: `miden-sync-${dbId}`, opts: { mode: "exclusive" } },
    ]);
  });

  it("propagates fn rejections through the lock", async () => {
    const dbId = uniqueDb();
    const err = new Error("inside-lock");
    installLocksMock(async (_name, _opts, fn) => fn());

    await expect(
      withSyncLock(dbId, "syncState", async () => {
        throw err;
      })
    ).rejects.toBe(err);
  });

  it("coalesces concurrent same-(dbId, methodId) calls: one lock acquisition", async () => {
    const dbId = uniqueDb();
    const requested = vi.fn(async (_name, _opts, fn) => fn());
    installLocksMock(requested);

    const fn = vi.fn(async () => "ok");
    const [a, b] = await Promise.all([
      withSyncLock(dbId, "syncState", fn),
      withSyncLock(dbId, "syncState", fn),
    ]);

    expect(a).toBe("ok");
    expect(b).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    // Coalesced: only one underlying lock request.
    expect(requested).toHaveBeenCalledTimes(1);
  });
});
