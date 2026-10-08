import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  setObserver,
  emitObservation,
  hasObserver,
  __resetObserverForTest,
} from "../observability.js";

afterEach(() => __resetObserverForTest());

describe("observability", () => {
  it("reports no observer until one is set", () => {
    expect(hasObserver()).toBe(false);
    setObserver(() => {});
    expect(hasObserver()).toBe(true);
  });

  it("delivers safe fields to the observer", () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    emitObservation({ op: "syncState", outcome: "ok", durationMs: 12 });
    expect(seen).toEqual([{ op: "syncState", outcome: "ok", durationMs: 12 }]);
  });

  it("delivers a failure outcome verbatim", () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    emitObservation({
      op: "proveTransaction",
      outcome: "error",
      durationMs: 7,
    });
    expect(seen).toEqual([
      { op: "proveTransaction", outcome: "error", durationMs: 7 },
    ]);
  });

  it("omits the sensitive key entirely when not supplied", () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    emitObservation({ op: "syncState", outcome: "ok", durationMs: 1 });
    expect("sensitive" in seen[0]).toBe(false);
  });

  it("includes the sensitive key only when supplied", () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    emitObservation({
      op: "syncState",
      outcome: "error",
      durationMs: 1,
      sensitive: { errorMessage: "boom" },
    });
    expect(seen[0].sensitive).toEqual({ errorMessage: "boom" });
  });

  it("is a no-op when no observer is registered", () => {
    expect(() =>
      emitObservation({ op: "syncState", outcome: "ok", durationMs: 1 })
    ).not.toThrow();
  });

  it("swallows an observer that throws", () => {
    setObserver(() => {
      throw new Error("observer blew up");
    });
    expect(() =>
      emitObservation({ op: "syncState", outcome: "ok", durationMs: 1 })
    ).not.toThrow();
  });

  it("keeps delivering after an observer throws", () => {
    const seen = [];
    setObserver((o) => {
      seen.push(o);
      throw new Error("observer blew up");
    });
    emitObservation({ op: "syncState", outcome: "ok", durationMs: 1 });
    emitObservation({ op: "syncChain", outcome: "ok", durationMs: 2 });
    expect(seen.map((o) => o.op)).toEqual(["syncState", "syncChain"]);
  });

  it("delivers synchronously, before the caller yields", () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    emitObservation({ op: "syncState", outcome: "ok", durationMs: 1 });
    // No await: a deferred delivery (microtask, timer, promise) fails here.
    expect(seen).toHaveLength(1);
  });

  it("unsubscribes via the returned function", () => {
    const observer = vi.fn();
    const off = setObserver(observer);
    off();
    emitObservation({ op: "syncState", outcome: "ok", durationMs: 1 });
    expect(observer).not.toHaveBeenCalled();
    expect(hasObserver()).toBe(false);
  });

  it("clears the observer when passed null", () => {
    setObserver(() => {});
    setObserver(null);
    expect(hasObserver()).toBe(false);
  });

  it("drops the observer on reset", () => {
    const observer = vi.fn();
    setObserver(observer);
    __resetObserverForTest();
    emitObservation({ op: "syncState", outcome: "ok", durationMs: 1 });
    expect(hasObserver()).toBe(false);
    expect(observer).not.toHaveBeenCalled();
  });

  it("does not let a stale unsubscribe clear a newer observer", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = setObserver(first);
    setObserver(second);
    offFirst();
    emitObservation({ op: "syncState", outcome: "ok", durationMs: 1 });
    expect(hasObserver()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("replaces the previous observer rather than fanning out", () => {
    const first = vi.fn();
    const second = vi.fn();
    setObserver(first);
    setObserver(second);
    emitObservation({ op: "syncState", outcome: "ok", durationMs: 1 });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("observability has no network capability", () => {
  it("contains no egress primitive", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../observability.js", import.meta.url)),
      "utf8"
    );
    for (const forbidden of [
      "fetch",
      "XMLHttpRequest",
      "sendBeacon",
      "WebSocket",
      "EventSource",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
