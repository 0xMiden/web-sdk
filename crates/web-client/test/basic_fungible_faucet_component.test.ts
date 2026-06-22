// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("basic fungible faucet", () => {
  // A single unified `FungibleFaucet` component backs both basic and network-style faucet
  // accounts, so reading metadata from it covers either kind — see the component's rustdoc.
  test("creates a basic fungible faucet component from an account", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const newFaucet = await client.newFaucet(
        sdk.AccountStorageMode.tryFromStr("public"),
        false,
        "DAG Token",
        "DAG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const basicFungibleFaucet =
        sdk.BasicFungibleFaucetComponent.fromAccount(newFaucet);

      return {
        symbol: basicFungibleFaucet.symbol().toString(),
        tokenName: basicFungibleFaucet.tokenName(),
        decimals: basicFungibleFaucet.decimals(),
        maxSupply: basicFungibleFaucet.maxSupply().toString(),
        tokenSupply: basicFungibleFaucet.tokenSupply().toString(),
        description: basicFungibleFaucet.description(),
        logoUri: basicFungibleFaucet.logoUri(),
        externalLink: basicFungibleFaucet.externalLink(),
      };
    });
    expect(result.symbol).toEqual("DAG");
    expect(result.tokenName).toEqual("DAG Token");
    expect(result.decimals).toEqual(8);
    expect(result.maxSupply).toEqual("10000000");
    // A freshly created faucet has not minted anything yet.
    expect(result.tokenSupply).toEqual("0");
    // The optional descriptive metadata is not set by `newFaucet`.
    expect(result.description).toBeUndefined();
    expect(result.logoUri).toBeUndefined();
    expect(result.externalLink).toBeUndefined();
  });

  test("throws an error when creating a basic fungible faucet from a non-faucet account", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const account = await client.newWallet(
        sdk.AccountStorageMode.tryFromStr("public"),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      try {
        sdk.BasicFungibleFaucetComponent.fromAccount(account);
        return { threw: false };
      } catch (e) {
        return { threw: true, message: e.message };
      }
    });
    expect(result.threw).toBe(true);
    expect(result.message).toContain(
      "failed to get basic fungible faucet details from account"
    );
  });
});
