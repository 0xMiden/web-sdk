import { describe, expect, it, vi } from "vitest";
import { createSdkWrapper, wrapClient } from "../node/napi-compat.js";

describe("Node optional RPC results", () => {
  it.each([
    ["getNullifierCommitHeight", [{}, 12], 0],
    ["getNoteScriptByRoot", [{}], { script: true }],
  ])("%s matches the browser absence contract", async (method, args, value) => {
    class RpcClient {
      result = null;
    }
    const nativeMethod = vi.fn(function () {
      return Promise.resolve(this.result);
    });
    RpcClient.prototype[method] = nativeMethod;
    const sdk = createSdkWrapper({ RpcClient });
    const rpc = new sdk.RpcClient();

    await expect(rpc[method](...args)).resolves.toBeUndefined();
    expect(nativeMethod).toHaveBeenLastCalledWith(...args);
    rpc.result = value;
    await expect(rpc[method](...args)).resolves.toBe(value);

    const error = new Error("RPC unavailable");
    nativeMethod.mockRejectedValueOnce(error);
    await expect(rpc[method](...args)).rejects.toBe(error);
  });
});

// napi-rs puts a getter on the prototype as an enumerable, configurable
// accessor and returns null for Option::None, where wasm-bindgen returns
// undefined.
function napiClass(getters, { configurable = true } = {}) {
  class Fake {
    constructor(fields) {
      this.fields = fields;
    }
  }
  for (const name of getters) {
    Object.defineProperty(Fake.prototype, name, {
      get() {
        return this.fields[name];
      },
      enumerable: true,
      configurable,
    });
  }
  return Fake;
}

describe("Node Option getters", () => {
  it("StorageValueSlotPatch.value reads undefined for a removed slot", () => {
    const StorageValueSlotPatch = napiClass(["value", "slotName"]);
    createSdkWrapper({ StorageValueSlotPatch });
    const word = {};

    const removed = new StorageValueSlotPatch({ value: null, slotName: null });
    expect(removed.value).toBeUndefined();
    expect(new StorageValueSlotPatch({ value: word }).value).toBe(word);
    // Only listed accessors are wrapped.
    expect(removed.slotName).toBeNull();
    expect(
      Object.getOwnPropertyDescriptor(StorageValueSlotPatch.prototype, "value")
    ).toMatchObject({ enumerable: true, configurable: true });
  });

  it("NetworkNoteStatusInfo.lastError reads undefined when there is none", () => {
    const NetworkNoteStatusInfo = napiClass(["lastError"]);
    createSdkWrapper({ NetworkNoteStatusInfo });

    expect(
      new NetworkNoteStatusInfo({ lastError: null }).lastError
    ).toBeUndefined();
    expect(new NetworkNoteStatusInfo({ lastError: "boom" }).lastError).toBe(
      "boom"
    );
  });

  it("leaves a non-configurable accessor as it is", () => {
    const Endpoint = napiClass(["port"], { configurable: false });
    const { get } = Object.getOwnPropertyDescriptor(Endpoint.prototype, "port");

    expect(() => createSdkWrapper({ Endpoint })).not.toThrow();
    expect(
      Object.getOwnPropertyDescriptor(Endpoint.prototype, "port").get
    ).toBe(get);
    expect(new Endpoint({ port: null }).port).toBeNull();
  });
});

describe("Node Note statics", () => {
  it("passes Uint8Array bytes to a Vec<u8> static as a plain Array", () => {
    const createXReserveBurnNote = vi.fn();
    const deserialize = vi.fn();
    class Note {}
    Note.createXReserveBurnNote = createXReserveBurnNote;
    Note.deserialize = deserialize;
    const sdk = createSdkWrapper({ Note });
    const bytes = new Uint8Array([1, 2, 3]);

    sdk.Note.createXReserveBurnNote("sender", "faucet", 5n, 6, bytes);
    expect(createXReserveBurnNote).toHaveBeenCalledWith(
      "sender",
      "faucet",
      5n,
      6,
      [1, 2, 3]
    );

    // deserialize takes JsBytes, which needs the view itself.
    sdk.Note.deserialize(bytes);
    expect(deserialize).toHaveBeenCalledWith(bytes);
  });
});

describe("Node batch submit and retryProvenBatch (#571)", () => {
  it("returns blockNumber when _submitNewTransactionBatchOutcome succeeds", async () => {
    const rawClient = {
      _submitNewTransactionBatchOutcome: vi
        .fn()
        .mockResolvedValue({ blockNumber: 42 }),
    };
    const wrapped = wrapClient(rawClient, "test-store", {});
    const items = [{ account: "a" }];

    await expect(wrapped.submitNewTransactionBatch(items)).resolves.toBe(42);
    expect(rawClient._submitNewTransactionBatchOutcome).toHaveBeenCalledWith(
      items
    );
  });

  it("throws Error with code, submission, and transactionIds on unknown outcome and retries with the handle", async () => {
    const firstSubmission = { transactionIds: () => [] };
    const secondSubmission = { transactionIds: () => [] };
    const rawClient = {
      _submitNewTransactionBatchOutcome: vi.fn().mockResolvedValue({
        errorMessage:
          "BATCH_SUBMISSION_OUTCOME_UNKNOWN: failed to submit transaction batch",
        errorCode: "BATCH_SUBMISSION_OUTCOME_UNKNOWN",
        submission: firstSubmission,
        transactionIds: ["0x1", "0x2"],
      }),
      _retryProvenBatchOutcome: vi
        .fn()
        .mockResolvedValueOnce({
          errorMessage:
            "BATCH_SUBMISSION_OUTCOME_UNKNOWN: failed to retry proven batch",
          errorCode: "BATCH_SUBMISSION_OUTCOME_UNKNOWN",
          submission: secondSubmission,
          transactionIds: ["0x1", "0x2"],
        })
        .mockResolvedValueOnce({ blockNumber: 99 }),
    };
    const wrapped = wrapClient(rawClient, "test-store", {});

    const err1 = await wrapped.submitNewTransactionBatch([]).catch((e) => e);
    expect(err1).toBeInstanceOf(Error);
    expect(err1).toMatchObject({
      code: "BATCH_SUBMISSION_OUTCOME_UNKNOWN",
      submission: firstSubmission,
      transactionIds: ["0x1", "0x2"],
    });

    const err2 = await wrapped
      .retryProvenBatch(err1.submission)
      .catch((e) => e);
    expect(err2).toBeInstanceOf(Error);
    expect(err2).toMatchObject({
      code: "BATCH_SUBMISSION_OUTCOME_UNKNOWN",
      submission: secondSubmission,
      transactionIds: ["0x1", "0x2"],
    });
    expect(rawClient._retryProvenBatchOutcome).toHaveBeenNthCalledWith(
      1,
      firstSubmission
    );

    await expect(
      wrapped.retryProvenBatch({ submission: err2.submission })
    ).resolves.toBe(99);
    expect(rawClient._retryProvenBatchOutcome).toHaveBeenNthCalledWith(
      2,
      secondSubmission
    );
  });

  it("propagates ordinary rejections from _...Outcome unchanged", async () => {
    const boom = new Error("ApplyTransactionAfterSubmitFailed: store failed");
    const rawClient = {
      _submitNewTransactionBatchOutcome: vi.fn().mockRejectedValue(boom),
      _retryProvenBatchOutcome: vi.fn().mockRejectedValue(boom),
    };
    const wrapped = wrapClient(rawClient, "test-store", {});

    await expect(wrapped.submitNewTransactionBatch([])).rejects.toBe(boom);
    await expect(wrapped.retryProvenBatch({})).rejects.toBe(boom);
  });

  it("falls back to direct methods when _...Outcome helpers are absent", async () => {
    const rawClient = {
      submitNewTransactionBatch: vi.fn().mockResolvedValue(12),
      retryProvenBatch: vi.fn().mockResolvedValue(15),
    };
    const wrapped = wrapClient(rawClient, "test-store", {});
    const handle = { kind: "submission" };

    await expect(wrapped.submitNewTransactionBatch([])).resolves.toBe(12);
    await expect(wrapped.retryProvenBatch(handle)).resolves.toBe(15);
    expect(rawClient.retryProvenBatch).toHaveBeenCalledWith(handle);
  });
});
