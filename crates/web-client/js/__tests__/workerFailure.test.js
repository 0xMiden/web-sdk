import { describe, expect, it, vi } from "vitest";
import { errorFromWorkerEvent, latchWorkerFailure } from "../workerFailure.js";

function makeClient() {
  return {
    workerFailure: null,
    pendingRequests: new Map(),
    readyRejecter: vi.fn(),
  };
}

describe("errorFromWorkerEvent", () => {
  it("uses event.message when present", () => {
    expect(errorFromWorkerEvent({ message: "boom" }).message).toBe("boom");
  });

  it("does not treat an empty message as the reason", () => {
    expect(errorFromWorkerEvent({ message: "" }).message).toBe(
      "Web worker failed to load or crashed"
    );
  });

  it("distinguishes messageerror from a load/crash failure", () => {
    expect(errorFromWorkerEvent({ type: "messageerror" }).message).toBe(
      "Web worker message could not be deserialized"
    );
  });
});

describe("latchWorkerFailure", () => {
  it("rejects pending requests, latches, and rejects ready once", () => {
    const client = makeClient();
    const first = vi.fn();
    const second = vi.fn();
    client.pendingRequests.set("a", { resolve: vi.fn(), reject: first });
    client.pendingRequests.set("b", { resolve: vi.fn(), reject: second });
    const preventDefault = vi.fn();

    const err = new Error("script failed");
    const latched = latchWorkerFailure(client, err, { preventDefault });

    expect(latched).toBe(err);
    expect(client.workerFailure).toBe(err);
    expect(first).toHaveBeenCalledWith(err);
    expect(second).toHaveBeenCalledWith(err);
    expect(client.pendingRequests.size).toBe(0);
    expect(client.readyRejecter).toHaveBeenCalledWith(err);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("is idempotent: a second failure does not re-flush", () => {
    const client = makeClient();
    const firstErr = new Error("first");
    latchWorkerFailure(client, firstErr);

    const reject = vi.fn();
    client.pendingRequests.set("late", { resolve: vi.fn(), reject });
    const second = latchWorkerFailure(client, new Error("second"));

    expect(second).toBe(firstErr);
    expect(client.workerFailure).toBe(firstErr);
    expect(reject).not.toHaveBeenCalled();
    expect(client.readyRejecter).toHaveBeenCalledOnce();
  });
});
