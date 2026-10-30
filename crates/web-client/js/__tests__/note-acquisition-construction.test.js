import { afterEach, expect, it, vi } from "vitest";
import fs from "fs";
vi.mock("../../Cargo.toml", () => ({}));
vi.mock("../wasm.js", () => ({
  default: async () => ({ resolveStoreName: (_rpc, name) => name }),
}));
import { MidenClient, WasmWebClient, MockWasmWebClient } from "../index.js";
import {
  createWasmWebClient,
  createMockWasmWebClient,
} from "../node/client-factory.js";

const limits = { maxNotes: 2, maxNoteFileBytes: 8, maxTotalNoteFileBytes: 16 };
const options = (callback = async () => {}) => ({
  beforeNoteAcquisition: callback,
  noteAcquisitionLimits: limits,
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["normal", "external", "mock"])(
  "installs the awaited native adapter before exposing %s clients",
  async (mode) => {
    let decision;
    const raw = {
      createClient: vi.fn(async () => {}),
      createClientWithExternalKeystore: vi.fn(async () => {}),
      createMockClient: vi.fn(async () => {}),
      serializeMockChain: vi.fn(async () => new Uint8Array()),
      serializeMockNoteTransportNode: vi.fn(async () => new Uint8Array()),
      installNoteAcquisitionGate: vi.fn(async (callback, actual) => {
        decision = callback;
        expect(actual).toEqual(limits);
      }),
      free() {},
    };
    vi.spyOn(WasmWebClient.prototype, "getWasmWebClient").mockResolvedValue(
      raw
    );
    const callback = vi.fn(async () => {});
    const client =
      mode === "mock"
        ? await MidenClient.createMock({
            ...options(callback),
            useWorker: false,
          })
        : await MidenClient.create({
            rpcUrl: "localhost",
            useWorker: false,
            ...options(callback),
            ...(mode === "external"
              ? { keystore: { getKey: async () => {} } }
              : {}),
          });
    expect(raw.installNoteAcquisitionGate).toHaveBeenCalledOnce();
    expect(
      await decision({
        noteFileBytes: new Uint8Array([1]),
        batchIndex: 0,
        batchCount: 1,
      })
    ).toBe("accepted");
    expect(callback).toHaveBeenCalledOnce();
    client.terminate();
    expect(
      await decision({
        noteFileBytes: new Uint8Array([1]),
        batchIndex: 0,
        batchCount: 1,
      })
    ).toBe("rejected");
  }
);

it("rejects all Node construction paths before filesystem or native construction", async () => {
  const mkdir = vi.spyOn(fs, "mkdirSync");
  const Native = vi.fn();
  const normal = createWasmWebClient({ WebClient: Native });
  const mock = createMockWasmWebClient({ WebClient: Native });
  await expect(
    normal.createClient(
      "rpc",
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      options()
    )
  ).rejects.toThrow(/unsupported.*native Node/);
  await expect(
    normal.createClientWithExternalKeystore(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      options()
    )
  ).rejects.toThrow(/unsupported.*native Node/);
  await expect(
    mock.createClient(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      options()
    )
  ).rejects.toThrow(/unsupported.*native Node/);
  expect(mkdir).not.toHaveBeenCalled();
  expect(Native).not.toHaveBeenCalled();
});

it("holds the worker acknowledgement until the matching owning operation has a receipt", async () => {
  const posted = [];
  let receive;
  const listeners = {};
  vi.stubGlobal(
    "Worker",
    class {
      addEventListener(type, callback) {
        listeners[type] = callback;
        if (type === "message") receive = callback;
      }
      postMessage(message) {
        posted.push(structuredClone(message));
      }
      terminate() {}
    }
  );
  let receipt;
  const callback = vi.fn(
    () =>
      new Promise((resolve) => {
        receipt = resolve;
      })
  );
  const client = new WasmWebClient(
    "rpc",
    undefined,
    undefined,
    "scope",
    undefined,
    undefined,
    undefined,
    undefined,
    true,
    options(callback)
  );
  await receive({ data: { loaded: true } });
  await Promise.resolve();
  expect(posted[0].args[13]).toEqual(limits);
  await receive({ data: { ready: true } });
  const operation = client.callMethodWithWorker("sync");
  await Promise.resolve();
  const request = posted.at(-1);
  const candidate = {
    noteFileBytes: new Uint8Array([1]),
    batchIndex: 0,
    batchCount: 1,
  };
  const notification = {
    action: "noteAcquisition",
    acquisitionId: 1,
    operationId: request.requestId,
    candidate,
  };
  const pending = receive({ data: notification });
  await Promise.resolve();
  expect(
    posted.some((message) => message.action === "noteAcquisitionAck")
  ).toBe(false);
  receipt();
  await pending;
  expect(posted.at(-1)).toMatchObject({
    action: "noteAcquisitionAck",
    decision: "accepted",
    operationId: request.requestId,
  });
  expect(callback.mock.calls[0][0].operationId).toBe(request.requestId);
  await receive({ data: notification });
  expect(posted.at(-1).decision).toBe("rejected");
  expect(callback).toHaveBeenCalledTimes(1);
  await receive({
    data: { ...notification, acquisitionId: 2, operationId: "lost" },
  });
  expect(posted.at(-1).decision).toBe("rejected");
  const lost = operation.catch((error) => error.message);
  listeners.error();
  expect(await lost).toBe("WebClient terminated");
  await receive({ data: notification });
});
