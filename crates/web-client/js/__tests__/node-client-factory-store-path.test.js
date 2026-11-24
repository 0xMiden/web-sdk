import { describe, it, expect } from "vitest";
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
});
