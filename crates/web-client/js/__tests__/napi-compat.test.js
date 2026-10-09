import { describe, expect, it } from "vitest";
import { createSdkWrapper } from "../node/napi-compat.js";

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
