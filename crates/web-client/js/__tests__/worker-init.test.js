import { describe, it, expect, beforeAll, vi } from "vitest";
import { WorkerAction } from "../constants.js";

// The worker loads the built bindings from dist/; a stub stands in for them so
// the INIT handler runs in node.
const created = [];
let initFailure;
vi.mock("../../dist/wasm.js", () => ({
  default: async () => ({
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
        const call = { method: "createMockClient", args, instance: this };
        created.push(call);
      }
      async installNoteAcquisitionGate(...args) {
        this.acquisitionGateArgs = args;
      }
    },
  }),
}));

const posted = [];

beforeAll(async () => {
  vi.stubGlobal("self", { postMessage: (message) => posted.push(message) });
  await import("../workers/web-client-methods-worker.js");
});

async function init(args) {
  const readyBefore = posted.filter((m) => m.ready).length;
  self.onmessage({ data: { action: WorkerAction.INIT, args } });
  await vi.waitFor(() => {
    expect(posted.filter((m) => m.ready).length).toBe(readyBefore + 1);
  });
  return created.at(-1);
}

async function initMock(args) {
  const readyBefore = posted.filter((m) => m.ready).length;
  self.onmessage({ data: { action: WorkerAction.INIT_MOCK, args } });
  await vi.waitFor(() => {
    expect(posted.filter((m) => m.ready).length).toBe(readyBefore + 1);
  });
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

it("keeps serialized mock state ahead of worker storage and acquisition options", async () => {
  const storageOptions = { durability: "strict", notify: true };
  const limits = { maxCandidates: 2 };
  const call = await initMock([
    "seed",
    undefined,
    1,
    new Uint8Array([1]).buffer,
    new Uint8Array([2]).buffer,
    storageOptions,
    limits,
  ]);

  expect(call.method).toBe("createMockClient");
  expect(call.args.slice(0, 3)).toEqual([
    "seed",
    new Uint8Array([1]),
    new Uint8Array([2]),
  ]);
  expect(call.args[3].durability).toBe("strict");
  expect(call.args[3].onFailure).toEqual(expect.any(Function));
  expect(call.instance.acquisitionGateArgs).toEqual([
    expect.any(Function),
    limits,
  ]);
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
