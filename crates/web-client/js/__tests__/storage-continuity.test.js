import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../Cargo.toml", () => ({}));
vi.mock("../wasm.js", () => ({
  default: async () => ({
    resolveStoreName: (_nodeUrl, storeName) => storeName,
  }),
}));

import { MidenClient, WasmWebClient } from "../index.js";
import { WorkerAction } from "../constants.js";
import { createWasmWebClient } from "../node/client-factory.js";

const STORE = "storage-continuity-test";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "forwards recovery options to browser WASM with external keystore %s",
  async (external) => {
    const wasm = {
      createClient: vi.fn(async () => {}),
      createClientWithExternalKeystore: vi.fn(async () => {}),
    };
    vi.spyOn(WasmWebClient.prototype, "getWasmWebClient").mockResolvedValue(
      wasm
    );
    const beforeNoteAcquisition = vi.fn(async () => {});
    const onFailure = vi.fn();
    const keystore = external
      ? { getKey: vi.fn(), insertKey: vi.fn(), sign: vi.fn() }
      : undefined;
    const client = await MidenClient.create({
      rpcUrl: "testnet",
      storeName: STORE,
      useWorker: false,
      keystore,
      beforeNoteAcquisition,
      indexedDb: { durability: "strict", onFailure },
    });

    const creation = external
      ? wasm.createClientWithExternalKeystore
      : wasm.createClient;
    const options = creation.mock.calls[0].at(-1);
    expect(options).toMatchObject({
      beforeNoteAcquisition: expect.any(Function),
      indexedDb: { durability: "strict", onFailure: expect.any(Function) },
    });
    const batch = {
      source: "import",
      notes: [Uint8Array.of(1, 2, 3)],
    };
    await options.beforeNoteAcquisition(batch);
    expect(beforeNoteAcquisition).toHaveBeenCalledWith(batch);
    client.terminate();
  }
);

it("waits for method-worker note retention and forwards sanitized storage failures", async () => {
  let worker;
  vi.stubGlobal(
    "Worker",
    class {
      messages = [];
      listeners = new Map();

      constructor() {
        worker = this;
      }
      addEventListener(name, listener) {
        this.listeners.set(name, listener);
      }
      postMessage(message) {
        this.messages.push(structuredClone(message));
      }
      emit(data) {
        return this.listeners.get("message")({ data });
      }
      terminate() {}
    }
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  const beforeNoteAcquisition = vi.fn(() => promise);
  const onFailure = vi.fn();
  const client = new WasmWebClient(
    "rpc",
    "transport",
    undefined,
    STORE,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
    { beforeNoteAcquisition, indexedDb: { durability: "strict", onFailure } }
  );
  await worker.emit({ loaded: true });
  await Promise.resolve();
  const init = worker.messages.find(
    ({ action }) => action === WorkerAction.INIT
  );
  expect(init.args.at(-1)).toEqual({
    beforeNoteAcquisition: true,
    indexedDb: { durability: "strict", notify: true },
  });

  const batch = { source: "note-transport", notes: [Uint8Array.of(7)] };
  const completion = worker.emit({
    action: WorkerAction.EXECUTE_CALLBACK,
    callbackType: "beforeNoteAcquisition",
    args: [batch],
    requestId: "retain",
  });
  expect(beforeNoteAcquisition).toHaveBeenCalledWith(batch);
  expect(
    worker.messages.some((item) => item.callbackRequestId === "retain")
  ).toBe(false);
  resolve();
  await completion;
  expect(worker.messages).toContainEqual({
    callbackOk: true,
    callbackResult: undefined,
    callbackRequestId: "retain",
  });

  const failure = { phase: "commit", kind: "io", errorName: "UnknownError" };
  await worker.emit({
    action: "indexedDbFailure",
    failure: { ...failure, message: "private note data" },
  });
  expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure);
  client.terminate();
});

it("rejects browser-only recovery options in the Node factory", async () => {
  const createClient = vi.fn(async () => {});
  const factory = createWasmWebClient(
    {
      WebClient: class {
        createClient = createClient;
      },
    },
    { dataDir: "/unused" }
  );
  await expect(
    factory.createClient(
      "rpc",
      undefined,
      undefined,
      STORE,
      undefined,
      undefined,
      { beforeNoteAcquisition: async () => {} }
    )
  ).rejects.toThrow(/beforeNoteAcquisition.*Node/);
  expect(createClient).not.toHaveBeenCalled();
});

it("uses the native commitment lookup without fetching the full note list", async () => {
  const commitment = "0x" + "01".repeat(32);
  const wasm = {
    NoteFilterTypes: { All: 0, DetailsCommitments: 1 },
    NoteFilter: class {
      constructor(type, _ids, _roots, commitments) {
        Object.assign(this, { type, commitments });
      }
    },
    Word: { fromHex: vi.fn((value) => ({ value })) },
  };
  const inner = { getInputNotes: vi.fn().mockResolvedValue(["note"]) };
  const client = new MidenClient(inner, async () => wasm);
  await expect(
    client.notes.list({ detailsCommitments: [commitment] })
  ).resolves.toEqual(["note"]);
  expect(inner.getInputNotes).toHaveBeenCalledWith({
    type: 1,
    commitments: [{ value: commitment }],
  });
});

it("passes the exclusive cursor and a bounded limit to the native page reader", async () => {
  const cursor = "0x" + "01".repeat(32);
  const inner = { getInputNotesPage: vi.fn().mockResolvedValue(["next"]) };
  const client = new MidenClient(inner, async () => ({ platform: "browser" }));
  // Report missing behavior as an assertion failure, even on a frozen SDK.
  expect(typeof client.notes.listPage).toBe("function");
  await expect(
    client.notes.listPage({ after: cursor, limit: 16 })
  ).resolves.toEqual(["next"]);
  expect(inner.getInputNotesPage).toHaveBeenCalledWith(cursor, 16);
  await expect(client.notes.listPage({ limit: 257 })).rejects.toThrow(
    RangeError
  );
  expect(inner.getInputNotesPage).toHaveBeenCalledTimes(1);
});
