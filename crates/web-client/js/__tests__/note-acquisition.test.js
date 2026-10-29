import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import {
  NoteAcquisitionRetentionError,
  validateNoteAcquisitionOptions,
  rejectNativeNoteAcquisition,
  createNoteAcquisitionOwner,
  createAcquisitionChannel,
} from "../noteAcquisition.js";

const limits = { maxNotes: 2, maxNoteFileBytes: 8, maxTotalNoteFileBytes: 16 };
const candidate = () => ({
  noteFileBytes: new Uint8Array([1, 2]),
  batchIndex: 0,
  batchCount: 1,
});
const options = (callback = async () => {}) => ({
  beforeNoteAcquisition: callback,
  noteAcquisitionLimits: limits,
});
const owner = (callback, active = () => true) =>
  createNoteAcquisitionOwner(options(callback), active);

describe("acquisition options", () => {
  it("keeps absent configuration absent", () => {
    expect(validateNoteAcquisitionOptions()).toBeUndefined();
    expect(createNoteAcquisitionOwner()).toBeUndefined();
    expect(rejectNativeNoteAcquisition()).toBeUndefined();
  });
  it.each([
    { beforeNoteAcquisition() {} },
    { noteAcquisitionLimits: limits },
    { beforeNoteAcquisition: true, noteAcquisitionLimits: limits },
    { beforeNoteAcquisition() {}, noteAcquisitionLimits: null },
    { beforeNoteAcquisition() {}, noteAcquisitionLimits: 2 },
  ])("requires a complete pair: %o", (value) => {
    expect(() => validateNoteAcquisitionOptions(value)).toThrow(TypeError);
  });
  it.each([-1, NaN, Infinity, 1.5, 0x100000000, undefined])(
    "rejects invalid bounded limits %s",
    (value) => {
      for (const field of Object.keys(limits))
        expect(() =>
          validateNoteAcquisitionOptions({
            ...options(),
            noteAcquisitionLimits: { ...limits, [field]: value },
          })
        ).toThrow(TypeError);
    }
  );
  it("copies limits and accepts zero", () => {
    const value = options();
    const config = validateNoteAcquisitionOptions(value);
    expect(config.limits).toEqual(limits);
    expect(config.limits).not.toBe(limits);
    expect(Object.isFrozen(config.limits)).toBe(true);
    expect(
      validateNoteAcquisitionOptions({
        ...value,
        noteAcquisitionLimits: {
          maxNotes: 0,
          maxNoteFileBytes: 0,
          maxTotalNoteFileBytes: 0,
        },
      }).limits.maxNotes
    ).toBe(0);
    expect(() => rejectNativeNoteAcquisition(value)).toThrow(
      /unsupported.*native Node/
    );
  });
});

describe("independent retention acknowledgements", () => {
  it("accepts a successful receipt returned as a Promise from another realm", async () => {
    const receipt = runInNewContext("Promise.resolve(undefined)");
    expect(receipt).not.toBeInstanceOf(Promise);
    expect(await owner(() => receipt).decide(candidate())).toBe("accepted");
  });
  it("waits for the receipt and copies operation metadata", async () => {
    let receipt;
    let delivered;
    const gate = owner((item) => {
      delivered = item;
      return new Promise((resolve) => {
        receipt = resolve;
      });
    });
    let settled = false;
    const result = gate.decide(candidate()).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(delivered.operationId).toMatch(/^acquisition-\d+-1$/);
    expect(Object.isFrozen(delivered)).toBe(true);
    receipt();
    expect(await result).toBe("accepted");
  });
  it("scopes direct operation identities to each owning client", async () => {
    const callback = vi.fn(async () => {});
    await owner(callback).decide(candidate());
    await owner(callback).decide(candidate());
    expect(callback.mock.calls[0][0].operationId).not.toBe(
      callback.mock.calls[1][0].operationId
    );
  });
  it("passes the worker operation identity without replacing it", async () => {
    const callback = vi.fn(async () => {});
    expect(await owner(callback).decide(candidate(), "worker-operation")).toBe(
      "accepted"
    );
    expect(callback.mock.calls[0][0].operationId).toBe("worker-operation");
  });
  it("preserves an operation ID for subsequent batch items", async () => {
    const callback = vi.fn(async () => {});
    const gate = owner(callback);
    expect(await gate.decide(candidate())).toBe("accepted");
    expect(
      await gate.decide({ ...candidate(), batchIndex: 1, batchCount: 2 })
    ).toBe("accepted");
    const ids = callback.mock.calls.map(([item]) => item.operationId);
    expect(ids[0]).toMatch(/^acquisition-\d+-1$/);
    expect(ids[1]).toBe(ids[0]);
  });
  it.each([
    () => undefined,
    () => "accepted",
    async () => "accepted",
    () => {
      throw new Error("secret");
    },
    async () => {
      throw new Error("secret");
    },
    async () => {
      throw { code: "NOTE_ACQUISITION_RETENTION_FAILED", secret: "private" };
    },
  ])(
    "refuses invalid acknowledgements without carrying arbitrary thrown values",
    async (callback) => {
      expect(await owner(callback).decide(candidate())).toBe("rejected");
    }
  );
  it.each([
    () => {
      throw new NoteAcquisitionRetentionError();
    },
    async () => {
      throw new NoteAcquisitionRetentionError();
    },
  ])(
    "recognizes only a deliberate independent retention failure",
    async (callback) => {
      expect(await owner(callback).decide(candidate())).toBe("retentionFailed");
    }
  );
  it("refuses retired or inactive owners before callback and after receipt", async () => {
    let active = true;
    const callback = vi.fn(async () => {
      active = false;
    });
    const gate = owner(callback, () => active);
    expect(await gate.decide(candidate())).toBe("rejected");
    expect(await gate.decide(candidate())).toBe("rejected");
    expect(callback).toHaveBeenCalledTimes(1);
    gate.retire();
    expect(await gate.decide(candidate())).toBe("rejected");
  });
  it("retirement releases a stuck receipt and blocks late success", async () => {
    let receipt;
    const gate = owner(
      () =>
        new Promise((resolve) => {
          receipt = resolve;
        })
    );
    const result = gate.decide(candidate());
    gate.retire();
    expect(await result).toBe("rejected");
    receipt();
    expect(await gate.decide(candidate())).toBe("rejected");
  });
  it("does not latch retention failure after owner loss", async () => {
    let active = true;
    const gate = owner(
      () => {
        active = false;
        throw new NoteAcquisitionRetentionError();
      },
      () => active
    );
    expect(await gate.decide(candidate())).toBe("rejected");
  });
  it.each([
    { noteFileBytes: [] },
    { noteFileBytes: new Uint8Array(9) },
    { batchCount: 3 },
    { batchCount: NaN },
    { batchIndex: -1 },
    { batchIndex: 1.1 },
    { batchIndex: 1 },
  ])("refuses invalid delivery %o", async (change) => {
    const callback = vi.fn(async () => {});
    expect(await owner(callback).decide({ ...candidate(), ...change })).toBe(
      "rejected"
    );
    expect(callback).not.toHaveBeenCalled();
  });
  it("rejects an orphaned later batch item", async () => {
    expect(
      await owner().decide({ ...candidate(), batchIndex: 1, batchCount: 2 })
    ).toBe("rejected");
  });
});

describe("worker retention channel", () => {
  it("binds the receipt to its operation and ignores duplicates", async () => {
    const send = vi.fn();
    const channel = createAcquisitionChannel(send);
    expect(channel.receive({ action: "other" })).toBe(false);
    expect(await channel.request(candidate())).toBe("rejected");
    const result = channel.request(candidate(), "op");
    const request = send.mock.calls[0][0];
    expect(
      channel.receive({
        ...request,
        action: "noteAcquisitionAck",
        decision: "accepted",
      })
    ).toBe(true);
    expect(await result).toBe("accepted");
    channel.receive({
      ...request,
      action: "noteAcquisitionAck",
      decision: "retentionFailed",
    });
    channel.close();
  });
  it.each([
    { operationId: "other", decision: "accepted" },
    { operationId: "op", decision: "invalid" },
    { operationId: "op", decision: "retentionFailed" },
  ])("sanitizes a mismatched or invalid reply %o", async (reply) => {
    let request;
    const channel = createAcquisitionChannel((message) => {
      request = message;
    });
    const result = channel.request(candidate(), "op");
    channel.receive({ ...request, ...reply, action: "noteAcquisitionAck" });
    expect(await result).toBe(
      reply.decision === "retentionFailed" ? "retentionFailed" : "rejected"
    );
  });
  it("rejects on timeout, owner loss and postMessage failure", async () => {
    vi.useFakeTimers();
    try {
      const channel = createAcquisitionChannel(() => {}, 10);
      const timeout = channel.request(candidate(), "op");
      await vi.advanceTimersByTimeAsync(10);
      expect(await timeout).toBe("rejected");
      const lost = channel.request(candidate(), "next");
      channel.close();
      expect(await lost).toBe("rejected");
      expect(await channel.request(candidate(), "after-close")).toBe(
        "rejected"
      );
      const broken = createAcquisitionChannel(() => {
        throw new Error("clone");
      });
      expect(await broken.request(candidate(), "op")).toBe("rejected");
      // Cover the production timeout default without leaving a timer behind.
      const defaultChannel = createAcquisitionChannel(() => {});
      const pending = defaultChannel.request(candidate(), "op");
      defaultChannel.close();
      expect(await pending).toBe("rejected");
    } finally {
      vi.useRealTimers();
    }
  });
});
