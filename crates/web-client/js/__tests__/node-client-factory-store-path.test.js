import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { createWasmWebClient } from "../node/client-factory.js";

function rawSdk() {
  const calls = [];
  class WebClient {
    async createClient(...args) {
      calls.push(args);
    }
  }
  return { sdk: { WebClient }, calls };
}

describe("the Node.js factory given the store identifier of an open store", () => {
  it("opens that SQLite file and its keystore", async () => {
    const dbPath = path.join(os.tmpdir(), "miden-client-abc", "store.db");
    for (const options of [undefined, { dataDir: "/nonexistent" }]) {
      const { sdk, calls } = rawSdk();
      await createWasmWebClient(sdk, options).createClient(
        "rpc",
        null,
        undefined,
        dbPath
      );
      expect(calls[0][3]).toBe(dbPath);
      expect(calls[0][4]).toBe(path.join(path.dirname(dbPath), "keystore"));
    }
  });

  it("reopens the store a client created under a relative dataDir", async () => {
    const options = { dataDir: "relative-store-root" };
    const first = rawSdk();
    await createWasmWebClient(first.sdk, options).createClient(
      "rpc",
      null,
      undefined,
      "wallet"
    );
    const created = first.calls[0][3];
    expect(path.isAbsolute(created)).toBe(true);

    const second = rawSdk();
    await createWasmWebClient(second.sdk, options).createClient(
      "rpc",
      null,
      undefined,
      created
    );
    expect(second.calls[0][3]).toBe(created);
    expect(second.calls[0][4]).toBe(first.calls[0][4]);
  });
});

describe("the Node.js factory claiming a store", () => {
  it("claims it by its canonical path, whatever spelling opens it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const real = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "miden-own-"))
    );
    const link = `${real}-link`;
    fs.symlinkSync(real, link);
    fs.mkdirSync(path.join(real, "nested"));
    const open = async (dbPath, exclusive) => {
      const { sdk, calls } = rawSdk();
      const client = await createWasmWebClient(sdk).createClient(
        "rpc",
        null,
        undefined,
        dbPath,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        exclusive
      );
      return { client, path: calls[0][3] };
    };
    const db = path.join(real, "store.db");
    const aliases = [`${real}/nested/../store.db`, path.join(link, "store.db")];
    try {
      const owner = await open(db, true);
      for (const alias of aliases) {
        await expect(open(alias, true)).rejects.toThrow(
          /client #1 of that store/
        );
      }
      owner.client.terminate();
      for (const alias of aliases) {
        const first = await open(db);
        const second = await open(alias);
        expect(second.path).toBe(first.path);
        first.client.terminate();
        second.client.terminate();
      }
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});
