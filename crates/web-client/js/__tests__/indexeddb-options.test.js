import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
vi.mock("../../Cargo.toml", () => ({}));
vi.mock("../wasm.js", () => ({
  default: async () => ({ resolveStoreName: (_rpc, name) => name }),
}));
import { MidenClient, WasmWebClient } from "../index.js";
import { WorkerAction } from "../constants.js";
import {
  createWasmWebClient,
  createMockWasmWebClient,
} from "../node/client-factory.js";
import {
  deliverIndexedDbFailure,
  validateIndexedDbOptions,
  createIndexedDbFailureSubscription,
} from "../indexeddb.js";

const failure = {
  backend: "indexeddb",
  storeName: "test-store",
  phase: "write",
  operation: "indexeddb.write",
  kind: "quota",
  errorName: "QuotaExceededError",
  eventId: "connection:1",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("IndexedDB construction boundaries", () => {
  it.each([false, true])(
    "preserves storage options across high-level and raw factories (external=%s)",
    async (external) => {
      const callbacks = [];
      const received = [];
      const raw = {
        createClient: async (...args) => {
          received.push(args);
          args.at(-1).onFailure(failure);
        },
        createClientWithExternalKeystore: async (...args) => {
          received.push(args);
          args.at(-1).onFailure(failure);
        },
        free() {},
      };
      vi.spyOn(WasmWebClient.prototype, "getWasmWebClient").mockResolvedValue(
        raw
      );
      const client = await MidenClient.create({
        rpcUrl: "http://localhost:57291",
        storeName: "test-store",
        useWorker: false,
        indexedDb: {
          durability: "strict",
          onFailure: (event) => callbacks.push(event),
        },
        ...(external ? { keystore: { sign: () => {} } } : {}),
      });
      expect(received[0].at(-1).durability).toBe("strict");
      expect(callbacks).toEqual([failure]);
      client.terminate();
      received[0].at(-1).onFailure(failure);
      expect(callbacks).toHaveLength(1);
    }
  );

  it("sends cloneable worker policy and delivers notifications synchronously before results", async () => {
    const posted = [];
    let receive;
    vi.stubGlobal(
      "Worker",
      class {
        addEventListener(type, callback) {
          if (type === "message") receive = callback;
        }
        postMessage(message) {
          posted.push(structuredClone(message));
        }
        terminate() {}
      }
    );
    const order = [];
    const client = new WasmWebClient(
      "rpc",
      undefined,
      undefined,
      "test-store",
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        durability: "strict",
        onFailure: () => {
          order.push("failure");
          throw new Error("consumer");
        },
      }
    );
    await receive({ data: { loaded: true } });
    await Promise.resolve();
    expect(posted[0].args[12]).toEqual({ durability: "strict", notify: true });
    await receive({ data: { ready: true } });
    const operation = client.callMethodWithWorker("getSetting", 1, "key");
    await Promise.resolve();
    const request = posted.find(
      (message) => message.methodName === "getSetting"
    );
    const caught = operation.catch((error) => {
      order.push("rejection");
      return error;
    });
    receive({ data: { action: WorkerAction.STORAGE_FAILURE, failure } });
    expect(order).toEqual(["failure"]);
    client._indexedDb.onFailure(failure);
    receive({ data: { action: WorkerAction.STORAGE_FAILURE, failure } });
    expect(order).toEqual(["failure"]);
    await receive({
      data: {
        requestId: request.requestId,
        error: { name: "Error", message: "original" },
      },
    });
    expect((await caught).message).toBe("original");
    expect(order).toEqual(["failure", "rejection"]);
    client.terminate();
    await receive({ data: { action: WorkerAction.STORAGE_FAILURE, failure } });
    expect(order).toHaveLength(2);
  });

  it.each([null, [], { durability: "strong" }, { onFailure: 1 }])(
    "rejects malformed construction policy before creating backend: %j",
    async (indexedDb) => {
      const factory = vi.spyOn(WasmWebClient.prototype, "getWasmWebClient");
      await expect(
        MidenClient.create({ rpcUrl: "testnet", indexedDb })
      ).rejects.toThrow(TypeError);
      expect(factory).not.toHaveBeenCalled();
    }
  );

  it.each([{}, { durability: "strict" }])(
    "rejects Node options before touching the filesystem: %j",
    async (indexedDb) => {
      const mkdir = vi.spyOn(fs, "mkdirSync");
      const Native = vi.fn();
      const sdk = { WebClient: Native };
      const factory = createWasmWebClient(sdk);
      await expect(
        factory.createClient(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          indexedDb
        )
      ).rejects.toThrow(/browser IndexedDB/);
      await expect(
        factory.createClientWithExternalKeystore(
          ...Array(13).fill(undefined),
          indexedDb
        )
      ).rejects.toThrow(/browser IndexedDB/);
      await expect(
        createMockWasmWebClient(sdk).createClient(
          undefined,
          undefined,
          undefined,
          undefined,
          indexedDb
        )
      ).rejects.toThrow(/browser IndexedDB/);
      expect(Native).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
    }
  );
});

describe("closed worker notification envelope", () => {
  it("strips payload fields and isolates callback mutation and exceptions", () => {
    const values = [];
    deliverIndexedDbFailure(
      (event) => {
        values.push(event);
        event.kind = "secret";
      },
      { ...failure, message: "private data", key: "private key" }
    );
    expect(values).toEqual([failure]);
    expect(Object.isFrozen(values[0])).toBe(true);
  });
  it.each([
    null,
    {},
    { backend: "sqlite" },
    { storeName: 4 },
    { eventId: "" },
    { eventId: 1 },
    { eventId: "x".repeat(129) },
    { phase: "unknown" },
    { operation: "private-key" },
    { kind: "constructor" },
    { errorName: "private-error" },
  ])("ignores malformed worker event %j", (change) => {
    const callback = vi.fn();
    deliverIndexedDbFailure(
      callback,
      change === null
        ? null
        : Object.keys(change).length
          ? { ...failure, ...change }
          : {}
    );
    expect(callback).not.toHaveBeenCalled();
  });
  it("allows omitted callbacks and unchanged default construction", () => {
    expect(validateIndexedDbOptions()).toBeUndefined();
    expect(validateIndexedDbOptions({})).toEqual({
      durability: undefined,
      onFailure: undefined,
    });
    expect(() => deliverIndexedDbFailure(undefined, failure)).not.toThrow();
  });
});

it("bounds deduplication to 64 event IDs per client and releases callbacks on disposal", () => {
  const firstCallback = vi.fn();
  const secondCallback = vi.fn();
  const first = createIndexedDbFailureSubscription(firstCallback, () => true);
  const second = createIndexedDbFailureSubscription(secondCallback, () => true);
  first.notify(failure);
  first.notify(failure);
  second.notify(failure);
  expect(firstCallback).toHaveBeenCalledTimes(1);
  expect(secondCallback).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 64; i++)
    first.notify({ ...failure, eventId: `other:${i}` });
  first.notify(failure);
  expect(firstCallback).toHaveBeenCalledTimes(66);
  first.dispose();
  first.notify({ ...failure, eventId: "after-dispose" });
  expect(firstCallback).toHaveBeenCalledTimes(66);
  second.notify({ ...failure, eventId: "after-dispose" });
  expect(secondCallback).toHaveBeenCalledTimes(2);
});
