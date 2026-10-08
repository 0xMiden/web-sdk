import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for the native module: the array polyfills and the entry's own
// wiring must work without it, and Account/Word let the StorageView install run.
// AuthScheme has the napi shape (names to values only) and WebClient records
// what the client wrapper forwards.
const fakeNative = vi.hoisted(() => {
  const rawStorage = {};
  class Account {
    storage() {
      return rawStorage;
    }
  }
  class Word {}
  class WebClient {
    constructor() {
      this.newWallet = vi.fn(async () => "wallet");
      this.newFaucet = vi.fn(async () => "faucet");
      this.importPublicAccountFromSeed = vi.fn(async () => "account");
    }
    async createClient(_rpcUrl, _noteTransportUrl, _seed, storePath) {
      this.storePath = storePath;
    }
    async createMockClient(storePath) {
      this.storePath = storePath;
    }
  }
  const AuthScheme = { AuthEcdsaK256Keccak: 1, AuthRpoFalcon512: 2 };
  return { Account, Word, WebClient, AuthScheme, rawStorage };
});
vi.mock("../node/loader.js", () => ({
  loadNativeModule: () => ({
    Account: fakeNative.Account,
    Word: fakeNative.Word,
    WebClient: fakeNative.WebClient,
    AuthScheme: fakeNative.AuthScheme,
  }),
}));

import * as nodeIndex from "../node-index.js";
import { NODE_ARRAY_TYPES } from "../node/napi-compat.js";
import { installStorageView, StorageView } from "../storageView.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

// The browser build gets its array containers from this macro, so it is the
// list the Node entry has to match.
const declaredArrays = [
  ...readFileSync(new URL("../../src/models/mod.rs", import.meta.url), "utf8")
    .match(/declare_js_miden_arrays!\s*\{([^}]*)\}/)[1]
    .matchAll(/->\s*(\w+)/g),
]
  .map((match) => match[1])
  .sort();

describe("Node array exports", () => {
  it("names every array declared by declare_js_miden_arrays!", () => {
    expect([...NODE_ARRAY_TYPES].sort()).toEqual(declaredArrays);
  });

  it.each(declaredArrays)("exports a usable %s constructor", (name) => {
    const ArrayType = nodeIndex[name];
    expect(ArrayType).toBeTypeOf("function");
    expect(nodeIndex.MidenArrays[name]).toBe(ArrayType);
    expect(new ArrayType()).toHaveLength(0);
    expect(new ArrayType([])).toHaveLength(0);
    const item = {};
    const items = new ArrayType([item]);

    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0]).toBe(item);
    expect(items.get(0)).toBe(item);
  });
});

describe("Node array container contract", () => {
  it.each(declaredArrays)(
    "%s rejects out-of-range get and replaceAt",
    (name) => {
      const first = {};
      const second = {};
      const items = new nodeIndex[name]([first, second]);
      const keys = Reflect.ownKeys(items);

      for (const index of [-1, 2]) {
        expect(() => items.get(index)).toThrow(/out of bounds/);
        expect(() => items.replaceAt(index, {})).toThrow(/out of bounds/);
      }
      expect(items[0]).toBe(first);
      expect(items[1]).toBe(second);
      expect(Reflect.ownKeys(items)).toEqual(keys);

      const replacement = {};
      expect(items.replaceAt(1, replacement)).toBe(items);
      expect(items[0]).toBe(first);
      expect(items[1]).toBe(replacement);
    }
  );

  it.each(declaredArrays)("%s can be freed like a wasm object", (name) => {
    const items = new nodeIndex[name]([{}]);

    expect(items.free()).toBeUndefined();
    expect(items[Symbol.dispose]()).toBeUndefined();
  });
});

describe("Node entry parity with the browser entry", () => {
  // Browser-only: the sync lock coordinates tabs and workers, and the
  // __*ForTest hooks are internal.
  const browserOnly = new Set(["withSyncLock"]);
  const browserExports = [
    ...readFileSync(path.join(packageRoot, "js/index.js"), "utf8").matchAll(
      /^export (?:const|let|function|class|async function)\s+(\w+)|^export \{([^}]*)\}/gm
    ),
  ]
    .flatMap((match) =>
      match[1]
        ? [match[1]]
        : match[2].split(",").map((part) =>
            part
              .trim()
              .split(/\s+as\s+/)
              .pop()
          )
    )
    .filter((name) => name && !name.startsWith("__") && !browserOnly.has(name));

  it.each(browserExports)("exports %s", (name) => {
    expect(nodeIndex[name]).toBeDefined();
  });

  it("installs StorageView on Account.storage() exactly once", () => {
    const account = new fakeNative.Account();
    expect(account.storage()).toBeInstanceOf(StorageView);

    installStorageView({ Account: fakeNative.Account, Word: fakeNative.Word });
    expect(account.storage().raw).toBe(fakeNative.rawStorage);
  });

  it("ships every file the Node entry imports", () => {
    const { files } = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8")
    );
    const shipped = (file) =>
      files.some((entry) => file === entry || file.startsWith(`${entry}/`));
    const seen = new Set();
    const pending = ["js/node-index.js"];
    while (pending.length > 0) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      // Comments quote import lines (node-index.js cites the browser's
      // `export * from "../Cargo.toml"`), so only scan code.
      const source = readFileSync(path.join(packageRoot, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const [, specifier] of source.matchAll(
        /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g
      )) {
        const target = path.posix.join(path.posix.dirname(file), specifier);
        if (existsSync(path.join(packageRoot, target))) pending.push(target);
      }
    }

    expect([...seen].filter((file) => !shipped(file))).toEqual([]);
  });
});

describe.each(["WasmWebClient", "MockWasmWebClient"])(
  "Node %s AuthScheme resolution",
  (factory) => {
    let client;
    let native;

    beforeEach(async () => {
      client = await nodeIndex[factory].createClient();
      native = client.wasmWebClient;
    });

    afterEach(() => {
      rmSync(path.dirname(native.storePath), { recursive: true, force: true });
    });

    it("newWallet hands the native client the Falcon enum value", async () => {
      await expect(client.newWallet("mode", "falcon")).resolves.toBe("wallet");
      expect(native.newWallet).toHaveBeenCalledWith("mode", 2, null);
    });

    it("newFaucet hands the native client the ECDSA enum value", async () => {
      await expect(
        client.newFaucet("mode", false, "Token", "TOK", 8, 1000n, "ecdsa")
      ).resolves.toBe("faucet");
      expect(native.newFaucet).toHaveBeenCalledWith(
        "mode",
        false,
        "Token",
        "TOK",
        8,
        1000n,
        1
      );
    });

    it("importPublicAccountFromSeed hands the native client the Falcon enum value", async () => {
      await expect(
        client.importPublicAccountFromSeed(new Uint8Array([1, 2, 3]), "falcon")
      ).resolves.toBe("account");
      expect(native.importPublicAccountFromSeed).toHaveBeenCalledWith(
        [1, 2, 3],
        2
      );
    });

    it("rejects a number that is not a native AuthScheme value", async () => {
      await expect(client.newWallet("mode", 99)).rejects.toThrow(
        'Unknown auth scheme: "99"'
      );
      expect(native.newWallet).not.toHaveBeenCalled();
    });
  }
);
