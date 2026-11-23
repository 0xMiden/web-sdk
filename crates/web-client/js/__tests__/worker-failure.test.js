import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("../../Cargo.toml", () => ({}));
import { WasmWebClient } from "../index.js";

class FakeWorker {
  static instances = [];

  constructor() {
    this.posted = [];
    this.listeners = new Map();
    this.terminate = vi.fn();
    FakeWorker.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  postMessage(message) {
    this.posted.push(message);
  }

  emit(type, event) {
    return this.listeners.get(type)?.(event);
  }
}

function createClient() {
  vi.stubGlobal("Worker", FakeWorker);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const client = new WasmWebClient(
    "https://rpc.example",
    undefined,
    undefined,
    "worker-failure-store"
  );
  return { client, worker: FakeWorker.instances.at(-1) };
}

const becomeReady = (worker) => {
  worker.emit("message", { data: { loaded: true } });
  worker.emit("message", { data: { ready: true } });
};

// What a promise has come to once timers drain: its rejection message,
// "resolved", or "pending".
const outcome = (promise) =>
  Promise.race([
    promise.then(
      () => "resolved",
      (error) => error.message
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 10)),
  ]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWorker.instances = [];
});

describe("a worker that fails", () => {
  it("rejects ready and queued calls when the worker script fails to load", async () => {
    const { client, worker } = createClient();
    const call = client.callMethodWithWorker("getAccounts");
    expect(client.workerFailure).toBeUndefined();

    worker.emit("error", { message: "" });

    await expect(outcome(client.ready)).resolves.toMatch(/worker failed/i);
    await expect(outcome(call)).resolves.toMatch(/worker failed/i);
    expect(worker.terminate).toHaveBeenCalled();
    expect(client.workerFailure).toBe(await call.catch((error) => error));
  });

  it("rejects an in-flight call and frees the call chain on an uncaught error", async () => {
    const { client, worker } = createClient();
    becomeReady(worker);
    const inFlight = client._serializeWasmCall(() =>
      client.callMethodWithWorker("getAccounts")
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.pendingRequests.size).toBe(1);

    worker.emit("error", { message: "Uncaught RuntimeError: unreachable" });

    await expect(outcome(inFlight)).resolves.toMatch(/unreachable/);
    await expect(outcome(client.waitForIdle())).resolves.toBe("resolved");
    expect(client.pendingRequests.size).toBe(0);
  });

  it("rejects later worker calls at once without posting to the dead worker", async () => {
    const { client, worker } = createClient();
    becomeReady(worker);
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.emit("error", { message: "boom" });
    const posted = worker.posted.length;

    await expect(
      outcome(client.callMethodWithWorker("getAccounts"))
    ).resolves.toMatch(/worker failed.*boom/i);
    expect(worker.posted).toHaveLength(posted);
  });

  it("treats a messageerror like an error", async () => {
    const { client, worker } = createClient();
    becomeReady(worker);
    const inFlight = client.callMethodWithWorker("getAccounts");
    await new Promise((resolve) => setTimeout(resolve, 0));

    worker.emit("messageerror", {});

    await expect(outcome(inFlight)).resolves.toMatch(/worker failed/i);
  });

  it("keeps the terminated error when the worker errors after terminate()", async () => {
    const { client, worker } = createClient();
    becomeReady(worker);
    client.terminate();

    worker.emit("error", { message: "late" });

    await expect(outcome(client.callMethodWithWorker("x"))).resolves.toBe(
      "WebClient terminated"
    );
    // The late error is not a second failure: nothing stops or reports it.
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });
});
