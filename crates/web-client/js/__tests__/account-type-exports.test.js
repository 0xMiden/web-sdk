import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// Only the binary boundary is mocked: exercise the real public entry points
// and resource dispatch so a JS export cannot silently shadow the native enum.
const { nativeAccountType } = vi.hoisted(() => ({
  nativeAccountType: { Private: 0, Public: 1 },
}));
vi.mock("../../Cargo.toml", () => ({ AccountType: nativeAccountType }));
vi.mock("../node/loader.js", () => ({
  loadNativeModule: () => ({ AccountType: nativeAccountType }),
}));

import * as browser from "../index.js";
import * as node from "../node-index.js";
import * as enums from "../enums.js";
import { AccountsResource } from "../resources/accounts.js";

const SHARED = [
  "FaucetType",
  "AuthScheme",
  "NoteVisibility",
  "StorageMode",
  "Linking",
];

it.each(SHARED)("both entries export the one shared %s", (name) => {
  expect(browser[name]).toBe(enums[name]);
  expect(node[name]).toBe(enums[name]);
});

describe.each([
  ["browser", browser],
  ["Node", node],
])("%s account type exports", (_name, sdk) => {
  it("preserves the native visibility enum", () => {
    expect(sdk.AccountType).toBe(nativeAccountType);
    expect(sdk.AccountType.Private).toBe(0);
    expect(sdk.AccountType.Public).toBe(1);
    expect(sdk.AccountType.FungibleFaucet).toBeUndefined();
  });

  it("exports an immutable string faucet selector distinct from AccountType", () => {
    expect(sdk.FaucetType).toEqual({ FungibleFaucet: "FungibleFaucet" });
    expect(sdk.FaucetType.NonFungibleFaucet).toBeUndefined();
    expect(Object.isFrozen(sdk.FaucetType)).toBe(true);
  });

  it.each([
    [
      "FaucetType.FungibleFaucet",
      (entry) => entry.FaucetType.FungibleFaucet,
      false,
    ],
    ["legacy numeric 1", () => 1, true],
  ])("routes %s to faucet creation", async (_label, selector, nonFungible) => {
    const inner = { newFaucet: vi.fn().mockResolvedValue("faucet") };
    const resource = new AccountsResource(
      inner,
      async () => ({
        AccountStorageMode: { public: () => "public" },
        AuthScheme: { AuthRpoFalcon512: 2 },
      }),
      { assertNotTerminated() {} }
    );
    await expect(
      resource.create({
        type: selector(sdk),
        symbol: "TOK",
        decimals: 8,
        maxSupply: 1000n,
      })
    ).resolves.toBe("faucet");
    expect(inner.newFaucet).toHaveBeenCalledWith(
      "public",
      nonFungible,
      "TOK",
      "TOK",
      8,
      1000n,
      2
    );
  });
});

it("ships every file the Node entry imports, including enums.js", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const { files } = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  );
  const shipped = (file) =>
    files.some((entry) => file === entry || file.startsWith(`${entry}/`));
  const seen = new Set();
  const pending = ["js/node-index.js"];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    // Comments quote import lines, so only scan code.
    const source = readFileSync(path.join(root, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const [, specifier] of source.matchAll(
      /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g
    )) {
      const target = path.posix.join(path.posix.dirname(file), specifier);
      if (existsSync(path.join(root, target))) pending.push(target);
    }
  }

  expect(seen.has("js/enums.js")).toBe(true);
  expect([...seen].filter((file) => !shipped(file))).toEqual([]);
});
