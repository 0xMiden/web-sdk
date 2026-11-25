import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MethodName, WorkerAction } from "../constants.js";

const posted = [];
let outcomes = [];

const makeSubmission = (ids) => ({
  free: vi.fn(),
  transactionIds: () => ids.map((id) => ({ toHex: () => id })),
});

const unknownOutcome = (submission) =>
  Object.assign(new Error("outcome unknown"), {
    code: "BATCH_SUBMISSION_OUTCOME_UNKNOWN",
    submission,
  });

beforeAll(async () => {
  vi.resetModules();
  vi.stubGlobal("__midenWorkerWasm", {
    AccountId: { fromHex: (hex) => ({ hex }) },
    TransactionRequest: { deserialize: (bytes) => ({ bytes }) },
    BatchItem: class {},
    WebClient: class {
      async createClient() {}
      lastAuthError() {
        return "auth-detail";
      }
      async submitNewTransactionBatch() {
        throw outcomes.shift();
      }
      async retryProvenBatch(submission) {
        const next = outcomes.shift();
        if (next) throw next;
        return 9;
      }
    },
  });
  vi.stubGlobal("self", { postMessage: (message) => posted.push(message) });
  vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../workers/web-client-methods-worker.js");
  self.onmessage({
    data: {
      action: WorkerAction.INIT,
      args: ["rpc", undefined, undefined, "store"],
    },
  });
  await vi.waitFor(() => expect(posted.some((m) => m.ready)).toBe(true));
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let nextRequestId = 1;
async function call(methodName, args) {
  const requestId = nextRequestId++;
  self.onmessage({
    data: { action: WorkerAction.CALL_METHOD, methodName, args, requestId },
  });
  await vi.waitFor(() =>
    expect(posted.some((m) => m.requestId === requestId)).toBe(true)
  );
  return posted.find((m) => m.requestId === requestId);
}

const submitBatch = () =>
  call(MethodName.SUBMIT_NEW_TRANSACTION_BATCH, [
    [["0xabc", new ArrayBuffer(1)]],
  ]);

describe("worker retryProvenBatch (#571)", () => {
  it("stashes the handle behind a cloneable id and frees it after a successful retry", async () => {
    const submission = makeSubmission(["0x1", "0x2"]);
    outcomes = [unknownOutcome(submission)];
    const failed = await submitBatch();
    expect(failed.error.code).toBe("BATCH_SUBMISSION_OUTCOME_UNKNOWN");
    expect(failed.error.transactionIds).toEqual(["0x1", "0x2"]);
    expect(failed.error.submission).toBeUndefined();

    const ok = await call(MethodName.RETRY_PROVEN_BATCH, [
      failed.error.submissionId,
    ]);
    expect(ok.result).toBe(9);
    expect(submission.free).toHaveBeenCalledTimes(1);

    const again = await call(MethodName.RETRY_PROVEN_BATCH, [
      failed.error.submissionId,
    ]);
    expect(again.error.message).toMatch(/Unknown proven batch submission id/);
  });

  it("keeps one entry per batch when a retry is again indeterminate", async () => {
    const first = makeSubmission(["0x1"]);
    const second = makeSubmission(["0x1"]);
    outcomes = [unknownOutcome(first)];
    const failed = await submitBatch();
    const id = failed.error.submissionId;

    outcomes = [unknownOutcome(second)];
    const retried = await call(MethodName.RETRY_PROVEN_BATCH, [id]);
    expect(retried.error.submissionId).toBe(id);
    expect(first.free).toHaveBeenCalledTimes(1);
    expect(second.free).not.toHaveBeenCalled();

    outcomes = [];
    const ok = await call(MethodName.RETRY_PROVEN_BATCH, [id]);
    expect(ok.result).toBe(9);
    expect(second.free).toHaveBeenCalledTimes(1);
  });

  it("appends the last auth error to a failed retry", async () => {
    outcomes = [unknownOutcome(makeSubmission(["0x1"]))];
    const failed = await submitBatch();
    outcomes = [Object.assign(new Error("boom"), { code: "X" })];
    const retried = await call(MethodName.RETRY_PROVEN_BATCH, [
      failed.error.submissionId,
    ]);
    expect(retried.error.message).toContain("auth-detail");
  });

  it("frees the handle when the retry was accepted but the local apply failed", async () => {
    const submission = makeSubmission(["0x1"]);
    outcomes = [unknownOutcome(submission)];
    const failed = await submitBatch();
    outcomes = [
      Object.assign(new Error("applying to the store failed"), {
        code: "ApplyTransactionAfterSubmitFailed",
      }),
    ];
    const retried = await call(MethodName.RETRY_PROVEN_BATCH, [
      failed.error.submissionId,
    ]);
    expect(retried.error.code).toBe("ApplyTransactionAfterSubmitFailed");
    expect(submission.free).toHaveBeenCalledTimes(1);
    const again = await call(MethodName.RETRY_PROVEN_BATCH, [
      failed.error.submissionId,
    ]);
    expect(again.error.message).toMatch(/Unknown proven batch submission id/);
  });

  it("frees the handle when the node definitively rejects the retry", async () => {
    const submission = makeSubmission(["0x1"]);
    outcomes = [unknownOutcome(submission)];
    const failed = await submitBatch();
    outcomes = [Object.assign(new Error("conflict"), { code: "Rejected" })];
    const retried = await call(MethodName.RETRY_PROVEN_BATCH, [
      failed.error.submissionId,
    ]);
    expect(retried.error.message).toContain("conflict");
    expect(submission.free).toHaveBeenCalledTimes(1);
    const again = await call(MethodName.RETRY_PROVEN_BATCH, [
      failed.error.submissionId,
    ]);
    expect(again.error.message).toMatch(/Unknown proven batch submission id/);
  });
});
