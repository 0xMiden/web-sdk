import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// A stand-in for the native module: the array polyfills and the entry's own
// wiring must work without it, and Account/Word let the StorageView install run.
const fakeNative = vi.hoisted(() => {
  const rawStorage = {};
  class Account {
    storage() {
      return rawStorage;
    }
  }
  class Word {}
  return { Account, Word, rawStorage };
});
vi.mock("../node/loader.js", () => ({
  loadNativeModule: () => ({
    Account: fakeNative.Account,
    Word: fakeNative.Word,
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
