import { readFileSync } from "node:fs";
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

  it("surfaces a worker's unknown-outcome error with its retry handle", async () => {
    const { client, worker } = createWorkerClient();
    const pending = client.retryProvenBatch({ submissionId: "3" });
    pending.catch(() => {});
    await vi.waitFor(() => expect(worker.posted.length).toBeGreaterThan(0));
    const request = worker.posted.at(-1);
    expect(request.methodName).toBe(MethodName.RETRY_PROVEN_BATCH);
    expect(request.args).toEqual(["3"]);
    worker.emit("message", {
      data: {
        requestId: request.requestId,
        methodName: request.methodName,
        error: {
          name: "Error",
          message: "outcome unknown",
          code: "BATCH_SUBMISSION_OUTCOME_UNKNOWN",
          submissionId: "3",
          transactionIds: ["0x1"],
        },
      },
    });
    await expect(pending).rejects.toMatchObject({
      code: "BATCH_SUBMISSION_OUTCOME_UNKNOWN",
      submissionId: "3",
      transactionIds: ["0x1"],
    });
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

  it("documents Node.js BATCH_SUBMISSION_OUTCOME_UNKNOWN and browser in-thread handles consistently", () => {
    const normalize = (text) => text.replace(/\s+/g, " ");
    const agentsMd = normalize(
      readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8")
    );
    expect(agentsMd).not.toContain(
      "Browser builds only: Node.js errors only prefix the message with the code."
    );
    expect(agentsMd).toContain(
      "`ApplyTransactionAfterSubmitFailed` fields are browser builds only: Node.js errors only prefix the message with the code."
    );
    expect(agentsMd).toMatch(
      /BATCH_SUBMISSION_OUTCOME_UNKNOWN[\s\S]*Node\.js[\s\S]*submission/
    );

    const indexJs = readFileSync(
      new URL("../index.js", import.meta.url),
      "utf8"
    );
    expect(
      indexJs.includes('`code: "BATCH_SUBMISSION_OUTCOME_UNKNOWN"` (in-thread)')
    ).toBe(false);
    expect(
      indexJs.includes(
        '`code: "BATCH_SUBMISSION_OUTCOME_UNKNOWN"` (browser in-thread)'
      )
    ).toBe(true);
  });

  it("keeps one accurate #571 entry in CHANGELOG.md Unreleased Enhancements", () => {
    const changelog = readFileSync(
      new URL("../../../../CHANGELOG.md", import.meta.url),
      "utf8"
    );
    const unreleased = changelog.split(/^## /m)[1] ?? "";
    const issue571Lines = unreleased
      .split("\n")
      .filter((line) => line.includes("web-sdk/issues/571"));
    expect(issue571Lines).toHaveLength(1);
    expect(issue571Lines[0]).toContain("browser in-thread and Node.js");
    expect(issue571Lines[0]).toContain("submissionId");
    expect(issue571Lines[0]).toContain("transactionIds");
    expect(issue571Lines[0]).not.toMatch(
      /Node\.js `transactions\.retryProvenBatch\(submission\)` now surfaces/
    );
  });
});
