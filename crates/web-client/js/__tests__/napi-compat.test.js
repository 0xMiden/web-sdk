import { describe, expect, it, vi } from "vitest";
import { createSdkWrapper } from "../node/napi-compat.js";

describe("Node optional RPC results", () => {
  it.each([
    ["getNullifierCommitHeight", [{}, 12], 0],
    ["getNoteScriptByRoot", [{}], { script: true }],
    ["getTransactionLogs", [{}, {}], { logs: true }],
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
