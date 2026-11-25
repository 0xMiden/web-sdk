import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MethodName, WorkerAction } from "../constants.js";

const created = [];
const posted = [];
let initFailure;

beforeAll(async () => {
  vi.resetModules();
  vi.stubGlobal("__midenWorkerWasm", {
    AccountId: { fromHex: (hex) => ({ hex }) },
    TransactionRequest: { deserialize: (bytes) => ({ bytes }) },
    TransactionProver: { deserialize: (bytes) => ({ bytes }) },
    WebClient: class {
      async createClient(...args) {
        created.push({ method: "createClient", args });
        if (initFailure) {
          args.at(-1).onFailure(initFailure);
          throw new Error("native open rejection");
        }
      }
      async createClientWithExternalKeystore(...args) {
        created.push({ method: "createClientWithExternalKeystore", args });
      }
      async createMockClient(...args) {
        created.push({ method: "createMockClient", args, instance: this });
      }
      async installNoteAcquisitionGate(...args) {
        this.acquisitionGateArgs = args;
      }
      async syncStateImpl() {
        return { serialize: () => new Uint8Array([1, 2]) };
      }
      async syncChainImpl() {
        return { serialize: () => new Uint8Array([3, 4]) };
      }
      async syncNoteTransportImpl() {}
      async executeTransaction() {
        return {
          id: () => ({ toHex: () => "0xtx" }),
          serialize: () => new Uint8Array([5]),
        };
      }
      async proveTransaction() {
        return { proven: true };
      }
      async submitProvenTransaction() {
        return 7;
      }
      async applyTransaction() {
        return { serialize: () => new Uint8Array([6]) };
      }
      async serializeMockChain() {
        return new Uint8Array([7]);
      }
      async serializeMockNoteTransportNode() {
        return new Uint8Array([8]);
      }
    },
  });
  vi.stubGlobal("self", { postMessage: (message) => posted.push(message) });
  await import("../workers/web-client-methods-worker.js");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function init(args) {
  const readyBefore = posted.filter((m) => m.ready).length;
  self.onmessage({ data: { action: WorkerAction.INIT, args } });
  await vi.waitFor(() => {
    expect(posted.filter((m) => m.ready).length).toBe(readyBefore + 1);
  });
  return created.at(-1);
}

let nextRequestId = 1;

async function initMock(args) {
  const readyBefore = posted.filter((m) => m.ready).length;
  self.onmessage({ data: { action: WorkerAction.INIT_MOCK, args } });
  await vi.waitFor(() => {
    expect(posted.filter((m) => m.ready).length).toBe(readyBefore + 1);
  });
  return created.at(-1);
}

async function callWorkerMethod(methodName, args) {
  const requestId = nextRequestId++;
  self.onmessage({
    data: { action: WorkerAction.CALL_METHOD, methodName, args, requestId },
  });
  await vi.waitFor(() => {
    expect(posted.some((m) => m.requestId === requestId)).toBe(true);
  });
  const reply = posted.find((m) => m.requestId === requestId);
  if (reply.error) {
    throw new Error(reply.error.message);
  }
  return created.at(-1);
}

describe("worker INIT", () => {
  it("passes args 10 and 11 to createClient after feeFaucetId", async () => {
    const call = await init([
      "rpc",
      "transport",
      undefined,
      "store",
      false,
      false,
      false,
      undefined,
      1,
      "0xfee",
      3,
      250,
    ]);
    expect(call.method).toBe("createClient");
    expect(call.args).toEqual([
      "rpc",
      "transport",
      undefined,
      "store",
      "0xfee",
      3,
      250,
    ]);
  });

  it("passes args 10 and 11 to createClientWithExternalKeystore after the callbacks", async () => {
    const call = await init([
      "rpc",
      "transport",
      undefined,
      "store",
      false,
      false,
      true,
      undefined,
      1,
      "0xfee",
      0,
      60_000,
    ]);
    expect(call.method).toBe("createClientWithExternalKeystore");
    expect(call.args).toHaveLength(10);
    expect(call.args[4]).toBe("0xfee");
    expect(typeof call.args[7]).toBe("function");
    expect(call.args[8]).toBe(0);
    expect(call.args[9]).toBe(60_000);
  });
});

describe("worker INIT_MOCK", () => {
  it("defaults omitted and nullish storeName to mock_client_db", async () => {
    for (const storeName of [undefined, null]) {
      const initCall = await initMock([
        undefined,
        undefined,
        1,
        new Uint8Array([1]).buffer,
        undefined,
        storeName,
      ]);
      expect(initCall.args[3]).toBe("mock_client_db");
    }
  });

  it("preserves empty string storeName across INIT_MOCK and SYNC_STATE_MOCK", async () => {
    const initCall = await initMock([
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "",
    ]);
    expect(initCall.args).toEqual([undefined, undefined, undefined, ""]);

    const syncCall = await callWorkerMethod(MethodName.SYNC_STATE_MOCK, [
      new Uint8Array([1]).buffer,
      null,
    ]);
    expect(syncCall.args[3]).toBe("");
  });

  it("forwards custom and empty storeName across all five worker mock handlers", async () => {
    for (const storeName of ["mock_isolated_db", ""]) {
      const initCall = await initMock([
        undefined,
        undefined,
        1,
        undefined,
        undefined,
        storeName,
      ]);
      expect(initCall.args[3]).toBe(storeName);

      const invocations = [
        [MethodName.SYNC_STATE_MOCK, [new Uint8Array([1]).buffer, null]],
        [MethodName.SYNC_CHAIN_MOCK, [new Uint8Array([1]).buffer, null]],
        [
          MethodName.SYNC_NOTE_TRANSPORT_MOCK,
          [new Uint8Array([1]).buffer, null],
        ],
        [
          MethodName.SUBMIT_NEW_TRANSACTION_MOCK,
          [
            "0xabc",
            new Uint8Array([2]).buffer,
            new Uint8Array([1]).buffer,
            null,
          ],
        ],
        [
          MethodName.SUBMIT_NEW_TRANSACTION_WITH_PROVER_MOCK,
          [
            "0xabc",
            new Uint8Array([2]).buffer,
            new Uint8Array([3]).buffer,
            new Uint8Array([1]).buffer,
            null,
          ],
        ],
      ];

      for (const [methodName, args] of invocations) {
        const call = await callWorkerMethod(methodName, args);
        expect(call.method).toBe("createMockClient");
        expect(call.args[3]).toBe(storeName);
      }
    }
  });
});

it("keeps serialized mock state and storeName ahead of worker storage and acquisition options", async () => {
  const storageOptions = { durability: "strict", notify: true };
  const limits = { maxCandidates: 2 };
  const call = await initMock([
    "seed",
    undefined,
    1,
    new Uint8Array([1]).buffer,
    new Uint8Array([2]).buffer,
    undefined,
    storageOptions,
    limits,
  ]);

  expect(call.method).toBe("createMockClient");
  expect(call.args.slice(0, 4)).toEqual([
    "seed",
    new Uint8Array([1]),
    new Uint8Array([2]),
    "mock_client_db",
  ]);
  expect(call.args[4].durability).toBe("strict");
  expect(call.args[4].onFailure).toEqual(expect.any(Function));
  expect(call.instance.acquisitionGateArgs).toEqual([
    expect.any(Function),
    limits,
  ]);

  const sync = await callWorkerMethod(MethodName.SYNC_STATE_MOCK, [
    new Uint8Array([1]).buffer,
    null,
  ]);
  expect(sync.args[4].durability).toBe("strict");
});

it("forwards cloneable storage policy and posts open failure before init rejection", async () => {
  const original = {
    backend: "indexeddb",
    storeName: "store",
    phase: "open",
    operation: "indexeddb.open",
    kind: "unavailable",
    errorName: "SecurityError",
    eventId: "worker:1",
  };
  initFailure = original;
  const start = posted.length;
  self.onmessage({
    data: {
      action: WorkerAction.INIT,
      args: [
        "rpc",
        undefined,
        undefined,
        "store",
        false,
        false,
        false,
        undefined,
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        { durability: "strict", notify: true },
      ],
    },
  });
  await vi.waitFor(() =>
    expect(posted.slice(start).some((message) => message.error)).toBe(true)
  );
  const messages = posted.slice(start);
  expect(created.at(-1).args.at(-1).durability).toBe("strict");
  expect(messages[0]).toEqual({
    action: WorkerAction.STORAGE_FAILURE,
    failure: original,
  });
  expect(messages[1].error.message).toBe("native open rejection");
  initFailure = undefined;
});
