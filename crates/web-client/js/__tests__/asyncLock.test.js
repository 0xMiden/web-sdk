import { describe, it, expect } from "vitest";
import { AsyncLock } from "../asyncLock.js";

describe("AsyncLock", () => {
  it("runs a single function and resolves with its result", async () => {
    const lock = new AsyncLock();
    const result = await lock.runExclusive(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("serializes two concurrent operations", async () => {
    const lock = new AsyncLock();
    const order = [];

    // Start first op and don't await yet
    const p1 = lock.runExclusive(async () => {
      order.push("start-1");
      await Promise.resolve();
      order.push("end-1");
      return "r1";
    });

    const p2 = lock.runExclusive(async () => {
      order.push("start-2");
      await Promise.resolve();
      order.push("end-2");
      return "r2";
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("r1");
    expect(r2).toBe("r2");
    // end-1 must come before start-2 (serialized)
    expect(order.indexOf("end-1")).toBeLessThan(order.indexOf("start-2"));
  });

  it("does not deadlock when one operation throws", async () => {
    const lock = new AsyncLock();
    const order = [];

    // First op throws
    const p1 = lock
      .runExclusive(async () => {
        order.push("start-1");
        throw new Error("oops");
      })
      .catch(() => order.push("caught-1"));

    // Second op should still run
    const p2 = lock.runExclusive(async () => {
      order.push("start-2");
      return "r2";
    });

    await Promise.all([p1, p2]);
    expect(order).toContain("start-2");
  });

  it("propagates errors to caller while continuing the chain", async () => {
    const lock = new AsyncLock();
    await expect(
      lock.runExclusive(() => Promise.reject(new Error("fail")))
    ).rejects.toThrow("fail");

    // Lock should still work after an error
    const result = await lock.runExclusive(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("handles synchronous return from fn (non-async)", async () => {
    const lock = new AsyncLock();
    const result = await lock.runExclusive(() => 99);
    expect(result).toBe(99);
  });
});
