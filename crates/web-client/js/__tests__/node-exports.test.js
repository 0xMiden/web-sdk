import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// A stand-in for the native module: the array polyfills and the entry's own
// wiring must work without it, and Account/Word let the StorageView install run.
const fakeNative = vi.hoisted(() => {
  const rawStorage = {};
  // What the native side was handed, last call last.
  const received = [];
  class Account {
    storage() {
      return rawStorage;
    }
    toCommitment(arg) {
      received.push(arg);
      return "commitment";
    }
  }
  // napi names the statics p2Id/p2Ide; the browser's p2id/p2ide are aliases.
  class NoteScript {
    static p2Id() {
      return "p2id";
    }
    static p2Ide() {
      return "p2ide";
    }
  }
  class Word {}
  class TransactionRequestBuilder {
    withOwnOutputNotes(notes) {
      received.push(notes);
      return this;
    }
  }
  class NoteStorage {
    constructor(felts) {
      received.push(felts);
    }
  }
  class SigningInputs {
    toElements() {
      return ["a", "b"];
    }
    arbitraryPayload() {
      return ["p"];
    }
  }
  class TransactionScriptInputPair {
    felts() {
      return ["f"];
    }
  }
  class EthAddress {
    static fromBytes(bytes) {
      received.push(bytes);
      return new EthAddress();
    }
  }
  class WebClient {
    async executeProgram() {
      return ["x", "y"];
    }
  }
  // A plain native function export (not a class) also carries a prototype.
  function exportStore(items) {
    received.push(items);
    return "exported";
  }
  return {
    Account,
    Word,
    TransactionRequestBuilder,
    NoteStorage,
    SigningInputs,
    TransactionScriptInputPair,
    EthAddress,
    WebClient,
    exportStore,
    NoteScript,
    rawStorage,
    received,
  };
});
vi.mock("../node/loader.js", () => ({
  loadNativeModule: () => ({
    Account: fakeNative.Account,
    Word: fakeNative.Word,
    TransactionRequestBuilder: fakeNative.TransactionRequestBuilder,
    NoteStorage: fakeNative.NoteStorage,
    SigningInputs: fakeNative.SigningInputs,
    TransactionScriptInputPair: fakeNative.TransactionScriptInputPair,
    EthAddress: fakeNative.EthAddress,
    WebClient: fakeNative.WebClient,
    exportStore: fakeNative.exportStore,
    NoteScript: fakeNative.NoteScript,
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
    expect(new ArrayType().length()).toBe(0);
    expect(new ArrayType([]).length()).toBe(0);
    const item = {};
    const items = new ArrayType([item]);

    expect(Array.isArray(items)).toBe(false);
    expect(typeof items.length).toBe("function");
    expect(items.length()).toBe(1);
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

      const third = {};
      expect(items.push(third)).toBe(items);
      expect(items.length()).toBe(3);
      expect(items[2]).toBe(third);
    }
  );

  it.each(declaredArrays)("%s can be freed like a wasm object", (name) => {
    const items = new nodeIndex[name]([{}]);

    expect(items.free()).toBeUndefined();
    expect(items[Symbol.dispose]()).toBeUndefined();
  });
});

describe("Node napi boundary", () => {
  it("hands a raw native method a real array of the container's items", () => {
    const first = {};
    const second = {};
    new nodeIndex.TransactionRequestBuilder().withOwnOutputNotes(
      new nodeIndex.NoteArray([first, second])
    );

    const received = fakeNative.received.at(-1);
    expect(Array.isArray(received)).toBe(true);
    expect(received).toEqual([first, second]);
    expect(received[0]).toBe(first);
  });

  it("hands a native constructor a real array of the container's items", () => {
    const felt = {};
    new nodeIndex.NoteStorage(new nodeIndex.FeltArray([felt]));

    const received = fakeNative.received.at(-1);
    expect(Array.isArray(received)).toBe(true);
    expect(received).toEqual([felt]);
  });

  it("calls a plain native function as a function, with a real array", () => {
    const item = {};

    expect(nodeIndex.exportStore(new nodeIndex.NoteArray([item]))).toBe(
      "exported"
    );
    expect(fakeNative.received.at(-1)).toEqual([item]);
  });

  it("keeps the NoteScript.p2id and p2ide aliases", () => {
    expect(nodeIndex.NoteScript.p2id()).toBe("p2id");
    expect(nodeIndex.NoteScript.p2ide()).toBe("p2ide");
  });

  it("unwraps containers passed to a snake_case alias", () => {
    const item = {};
    new fakeNative.Account().to_commitment(new nodeIndex.NoteArray([item]));

    expect(fakeNative.received.at(-1)).toEqual([item]);
  });

  it("lets a subclass of an exported native class keep its own methods", () => {
    class Sub extends nodeIndex.NoteStorage {
      tag() {
        return 1;
      }
    }
    const sub = new Sub(new nodeIndex.FeltArray([]));
    expect(sub).toBeInstanceOf(Sub);
    expect(sub.tag()).toBe(1);

    class W extends nodeIndex.Word {
      tag() {
        return 2;
      }
    }
    expect(new W().tag()).toBe(2);
  });

  it("keeps each wrapped export's class or function name", () => {
    expect(nodeIndex.TransactionRequestBuilder.name).toBe(
      "TransactionRequestBuilder"
    );
    expect(new nodeIndex.Word().constructor.name).toBe("Word");
    expect(nodeIndex.exportStore.name).toBe("exportStore");
  });

  it("reports the export as an instance's constructor", () => {
    expect(new nodeIndex.TransactionRequestBuilder().constructor).toBe(
      nodeIndex.TransactionRequestBuilder
    );
    expect(new nodeIndex.Word().constructor).toBe(nodeIndex.Word);
    expect(nodeIndex.Word()).toBeInstanceOf(nodeIndex.Word);
  });

  it("leaves byte arguments to native methods untouched", () => {
    const bytes = new Uint8Array(20);
    nodeIndex.EthAddress.fromBytes(bytes);

    expect(fakeNative.received.at(-1)).toBe(bytes);
  });

  it.each([
    ["SigningInputs", "toElements", ["a", "b"]],
    ["SigningInputs", "arbitraryPayload", ["p"]],
    ["TransactionScriptInputPair", "felts", ["f"]],
  ])("returns %s.%s as a container", (cls, method, items) => {
    const result = new nodeIndex[cls]()[method]();

    expect(result.length()).toBe(items.length);
    expect(result.get(0)).toBe(items[0]);
  });

  it("returns executeProgram's felts as a container", async () => {
    const result = await new fakeNative.WebClient().executeProgram();
    expect(result.length()).toBe(2);
    expect(result.get(1)).toBe("y");
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
