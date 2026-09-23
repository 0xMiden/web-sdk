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
import { AccountsResource } from "../resources/accounts.js";

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

  it("exports separate, immutable numeric faucet selectors", () => {
    expect(sdk.FaucetType).toEqual({ FungibleFaucet: 0, NonFungibleFaucet: 1 });
    expect(Object.isFrozen(sdk.FaucetType)).toBe(true);
  });

  it.each([
    ["FungibleFaucet", false],
    ["NonFungibleFaucet", true],
  ])("routes %s to faucet creation", async (kind, nonFungible) => {
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
        type: sdk.FaucetType?.[kind],
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
