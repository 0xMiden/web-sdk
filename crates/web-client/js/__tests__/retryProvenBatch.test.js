import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../Cargo.toml", () => ({}));
vi.mock("../wasm.js", () => ({
  default: async () => ({}),
  resolveWasmUrl: async () => undefined,
}));

import { WasmWebClient } from "../index.js";
import { MethodName } from "../constants.js";

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

function createWorkerClient() {
  vi.stubGlobal("Worker", FakeWorker);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const client = new WasmWebClient(
    "https://rpc.example",
    undefined,
    undefined,
    "retry-proven-batch-store"
  );
  const worker = FakeWorker.instances.at(-1);
  worker.emit("message", { data: { loaded: true } });
  worker.emit("message", { data: { ready: true } });
  return { client, worker };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWorker.instances = [];
});

describe("retryProvenBatch (#571)", () => {
  it("forwards only the submissionId to the worker method", async () => {
    const { client } = createWorkerClient();
    const call = vi.spyOn(client, "callMethodWithWorker").mockResolvedValue(42);

    await expect(client.retryProvenBatch({ submissionId: "3" })).resolves.toBe(
      42
    );

    expect(call).toHaveBeenCalledWith(MethodName.RETRY_PROVEN_BATCH, "3");
  });

  it("rejects under a worker when submissionId is missing", async () => {
    const { client } = createWorkerClient();
    await expect(client.retryProvenBatch({})).rejects.toThrow(
      /submission\.submissionId/
    );
  });

  it("in-thread path forwards the WASM submission handle", async () => {
    vi.stubGlobal("Worker", undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const client = new WasmWebClient(
      "https://rpc.example",
      undefined,
      undefined,
      "retry-proven-in-thread",
      undefined,
      undefined,
      undefined,
      undefined,
      false
    );
    const submission = { kind: "submission" };
    const wasmClient = {
      retryProvenBatch: vi.fn().mockResolvedValue(17),
    };
    client.wasmWebClient = wasmClient;
    client.wasmWebClientPromise = Promise.resolve(wasmClient);

    await expect(client.retryProvenBatch(submission)).resolves.toBe(17);
    expect(wasmClient.retryProvenBatch).toHaveBeenCalledWith(submission);
  });
});
