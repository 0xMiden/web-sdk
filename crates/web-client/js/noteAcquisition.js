const retentionFailures = new WeakSet();
let nextOwnerId = 0;

/** Signal a known independent retention write, readback or continuity failure. */
export class NoteAcquisitionRetentionError extends Error {
  constructor() {
    super("Note acquisition retention failed");
    retentionFailures.add(this);
  }
}

export function validateNoteAcquisitionOptions(options) {
  const callback = options?.beforeNoteAcquisition;
  const limits = options?.noteAcquisitionLimits;
  if (callback === undefined && limits === undefined) return undefined;
  if (
    typeof callback !== "function" ||
    !limits ||
    typeof limits !== "object" ||
    Array.isArray(limits)
  ) {
    throw new TypeError(
      "beforeNoteAcquisition and noteAcquisitionLimits must be provided together"
    );
  }
  const copied = {};
  for (const name of [
    "maxNotes",
    "maxNoteFileBytes",
    "maxTotalNoteFileBytes",
  ]) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new TypeError(
        `Invalid noteAcquisitionLimits.${name}: expected a nonnegative u32`
      );
    }
    copied[name] = value;
  }
  return { callback, limits: Object.freeze(copied) };
}

export function rejectNativeNoteAcquisition(options) {
  if (validateNoteAcquisitionOptions(options)) {
    throw new TypeError(
      "Note acquisition callbacks are unsupported by native Node"
    );
  }
}

export function createNoteAcquisitionOwner(options, isActive) {
  const config = validateNoteAcquisitionOptions(options);
  if (!config) return undefined;
  const ownerId = ++nextOwnerId;
  let active = true;
  let sequence = 0;
  let operationId;
  const pending = new Set();
  const live = () => active && isActive();
  return {
    limits: config.limits,
    async decide(candidate, operation) {
      if (!live()) return "rejected";
      if (candidate.batchIndex === 0)
        operationId = `acquisition-${ownerId}-${++sequence}`;
      const id = operation ?? operationId;
      if (
        !id ||
        !(candidate.noteFileBytes instanceof Uint8Array) ||
        candidate.noteFileBytes.byteLength > config.limits.maxNoteFileBytes ||
        !Number.isSafeInteger(candidate.batchCount) ||
        candidate.batchCount > config.limits.maxNotes ||
        !Number.isSafeInteger(candidate.batchIndex) ||
        candidate.batchIndex < 0 ||
        candidate.batchIndex >= candidate.batchCount
      ) {
        return "rejected";
      }
      let retire;
      const retired = new Promise((resolve) => {
        retire = () => resolve("rejected");
      });
      pending.add(retire);
      try {
        const result = config.callback(
          Object.freeze({ ...candidate, operationId: id })
        );
        if (typeof result?.then !== "function") return "rejected";
        const decision = await Promise.race([
          Promise.resolve(result).then(
            (value) => (value === undefined ? "accepted" : "rejected"),
            (error) =>
              retentionFailures.has(error) ? "retentionFailed" : "rejected"
          ),
          retired,
        ]);
        return live() ? decision : "rejected";
      } catch (error) {
        return live() && retentionFailures.has(error)
          ? "retentionFailed"
          : "rejected";
      } finally {
        pending.delete(retire);
      }
    },
    retire() {
      active = false;
      config.callback = undefined;
      for (const resolve of pending) resolve();
      pending.clear();
    },
  };
}

/** Worker acknowledgement channel; only its active operation can consume a reply. */
export function createAcquisitionChannel(send, timeoutMs = 30000) {
  let sequence = 0;
  const pending = new Map();
  let closed = false;
  return {
    request(candidate, operationId) {
      if (closed || !operationId) return Promise.resolve("rejected");
      const acquisitionId = ++sequence;
      return new Promise((resolve) => {
        const settle = (decision) => {
          clearTimeout(timer);
          pending.delete(acquisitionId);
          resolve(decision);
        };
        const timer = setTimeout(() => settle("rejected"), timeoutMs);
        pending.set(acquisitionId, { operationId, settle });
        try {
          send({
            action: "noteAcquisition",
            acquisitionId,
            operationId,
            candidate,
          });
        } catch {
          settle("rejected");
        }
      });
    },
    receive(message) {
      if (message.action !== "noteAcquisitionAck") return false;
      const entry = pending.get(message.acquisitionId);
      if (entry)
        entry.settle(
          entry.operationId === message.operationId &&
            ["accepted", "retentionFailed", "rejected"].includes(
              message.decision
            )
            ? message.decision
            : "rejected"
        );
      return true;
    },
    close() {
      closed = true;
      for (const entry of pending.values()) entry.settle("rejected");
    },
  };
}
