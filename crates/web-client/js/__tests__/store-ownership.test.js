import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";

const fakeWasm = vi.hoisted(() => {
  // Every open, browser or Node.js, rejects with this when a test sets it.
  const failOpen = async () => {
    if (wasm.openFailure) throw wasm.openFailure;
  };
  const wasm = {
    openFailure: null,
    failOpen,
    WebClient: class {
      constructor() {
        this.createClient = failOpen;
        this.createClientWithExternalKeystore = failOpen;
        this.free = () => {};
      }
    },
    resolveStoreName: (nodeUrl, storeName) =>
      storeName ?? `MidenClientDB_${nodeUrl}`,
  };
  return wasm;
});
vi.mock("../../Cargo.toml", () => ({}));
vi.mock("../wasm.js", () => ({ default: async () => fakeWasm }));

import { MidenClient } from "../client.js";
import { WasmWebClient } from "../index.js";
import { createWasmWebClient } from "../node/client-factory.js";

let storeCounter = 0;
const uniqueStore = () => `store-ownership-${++storeCounter}-${Date.now()}`;

// Browser factories, with the worker off.
const browser = {
  open: (store, exclusive) =>
    WasmWebClient.createClient(
      "rpc",
      undefined,
      undefined,
      store,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      exclusive
    ),
  openWithKeystore: (store, exclusive) =>
    WasmWebClient.createClientWithExternalKeystore(
      "rpc",
      undefined,
      undefined,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      exclusive
    ),
};

// The Node.js factory over a native client that opens nothing.
const nodeFactory = createWasmWebClient(
  {
    WebClient: class {
      createClient = fakeWasm.failOpen;
    },
  },
  { dataDir: path.join(os.tmpdir(), "miden-store-ownership-test") }
);
const node = {
  open: (store, exclusive) =>
    nodeFactory.createClient(
      "rpc",
      null,
      undefined,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      exclusive
    ),
};

let warn;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  fakeWasm.openFailure = null;
  vi.restoreAllMocks();
});

for (const [name, factory] of [
  ["browser createClient", browser.open],
  ["browser createClientWithExternalKeystore", browser.openWithKeystore],
  ["Node.js createClient", node.open],
]) {
  describe(`a second ${name} on an open store`, () => {
    it("warns, naming the client that has the store open", async () => {
      const store = uniqueStore();
      const first = await factory(store);
      expect(warn).not.toHaveBeenCalled();
      const second = await factory(store);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(store);
      expect(warn.mock.calls[0][0]).toContain("client #1");
      first.terminate();
      second.terminate();
    });

    it("refuses, naming the owner, when it asks for exclusive use", async () => {
      const store = uniqueStore();
      const first = await factory(store);
      await expect(factory(store, true)).rejects.toThrow(
        new RegExp(`${store}.*client #1`)
      );
      first.terminate();
      // The refused open holds no claim: the store is free again.
      const again = await factory(store, true);
      again.terminate();
      expect(warn).not.toHaveBeenCalled();
    });

    it("refuses any open of a store an exclusive client holds", async () => {
      const store = uniqueStore();
      const owner = await factory(store, true);
      await expect(factory(store)).rejects.toThrow(
        new RegExp(`${store}.*client #1`)
      );
      owner.terminate();
    });

    it("opens cleanly once the owner is terminated", async () => {
      const store = uniqueStore();
      const first = await factory(store, true);
      first.terminate();
      first.terminate();
      const second = await factory(store, true);
      const third = await factory(uniqueStore(), true);
      expect(warn).not.toHaveBeenCalled();
      second.terminate();
      third.terminate();
    });

    it("holds no claim after an open that failed", async () => {
      const store = uniqueStore();
      fakeWasm.openFailure = new Error("node unreachable");
      await expect(factory(store, true)).rejects.toThrow("node unreachable");
      fakeWasm.openFailure = null;
      (await factory(store, true)).terminate();
      expect(warn).not.toHaveBeenCalled();
    });

    it("leaves a client on another store alone", async () => {
      const a = await factory(uniqueStore(), true);
      const b = await factory(uniqueStore(), true);
      expect(warn).not.toHaveBeenCalled();
      a.terminate();
      b.terminate();
    });
  });
}

describe("MidenClient.create", () => {
  const create = (storeName, exclusive) =>
    MidenClient.create({
      rpcUrl: "http://localhost:57291",
      storeName,
      exclusive,
    });

  it("passes exclusive through and releases the store on terminate", async () => {
    const store = uniqueStore();
    const owner = await create(store, true);
    await expect(create(store)).rejects.toThrow(
      new RegExp(`${store}.*client #1`)
    );
    owner.terminate();
    const next = await create(store);
    expect(warn).not.toHaveBeenCalled();
    await next[Symbol.asyncDispose]();
    (await create(store)).terminate();
    expect(warn).not.toHaveBeenCalled();
  });
});
