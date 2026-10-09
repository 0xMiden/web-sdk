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

  test("creates a basic fungible faucet component from account storage", async ({
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
        sdk.BasicFungibleFaucetComponent.fromAccountStorage(
          newFaucet.storage()
        );

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

  test("throws an error when creating a basic fungible faucet from non-faucet account storage", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const account = await client.newWallet(
        sdk.AccountStorageMode.tryFromStr("public"),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      try {
        sdk.BasicFungibleFaucetComponent.fromAccountStorage(account.storage());
        return { threw: false };
      } catch (e) {
        return { threw: true, message: e.message };
      }
    });
    expect(result.threw).toBe(true);
    expect(result.message).toContain(
      "failed to get basic fungible faucet details from account storage"
    );
  });

  // The #243 scenario: an account (like the AggLayer bridged-asset faucet) that
  // reuses the standards faucet storage layout but exposes a different MASM
  // interface. `fromAccount` is gated on the interface and throws, while
  // `fromAccountStorage` reads the metadata straight from the slots.
  test("reads metadata via storage for a faucet-layout account without the faucet interface", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      // Build a real faucet only to harvest its storage slot values.
      const newFaucet = await client.newFaucet(
        sdk.AccountStorageMode.tryFromStr("public"),
        false,
        "AGG Token",
        "AGG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const faucetStorage = newFaucet.storage();
      // StorageView wraps the raw storage in the browser; Node returns it directly.
      const rawStorage = faucetStorage.raw ?? faucetStorage;

      // Copy the standards faucet value slots into a custom component whose
      // code is NOT the basic fungible faucet interface.
      const slots = rawStorage
        .getSlotNames()
        .filter((name) => name.startsWith("miden::standards::faucets::"))
        .map((name) => {
          const value = rawStorage.getItem(name);
          return value ? sdk.StorageSlot.fromValue(name, value) : undefined;
        })
        .filter(Boolean);

      const code = `
        use miden::core::sys

        pub proc custom_entrypoint
            exec.sys::truncate_stack
        end
      `;
      const builder = await client.createCodeBuilder();
      const library = builder.buildLibrary(
        "miden::testing::fake_agg_faucet",
        code
      );
      const component = sdk.AccountComponent.fromLibrary(
        library,
        slots
      ).withSupportsAllTypes();

      const seed = new Uint8Array(32);
      crypto.getRandomValues(seed);
      const secretKey = sdk.AuthSecretKey.rpoFalconWithRNG(seed);
      const auth =
        sdk.AccountComponent.createAuthComponentFromSecretKey(secretKey);
      const { account } = new sdk.AccountBuilder(seed)
        .withAuthComponent(auth)
        .withComponent(component)
        .storageMode(sdk.AccountStorageMode.public())
        .build();

      // Read the storage first: fromAccount takes the wasm Account by value,
      // so the handle is consumed even when the call throws.
      const accountStorage = account.storage();

      let fromAccountError;
      try {
        sdk.BasicFungibleFaucetComponent.fromAccount(account);
      } catch (e) {
        fromAccountError = e.message;
      }

      const meta =
        sdk.BasicFungibleFaucetComponent.fromAccountStorage(accountStorage);

      return {
        copiedSlots: slots.length,
        fromAccountError,
        symbol: meta.symbol().toString(),
        tokenName: meta.tokenName(),
        decimals: meta.decimals(),
        maxSupply: meta.maxSupply().toString(),
      };
    });
    expect(result.copiedSlots).toBeGreaterThan(0);
    // The interface gate rejects the account...
    expect(result.fromAccountError).toContain(
      "failed to get basic fungible faucet details from account"
    );
    // ...but the storage path reads the metadata.
    expect(result.symbol).toEqual("AGG");
    expect(result.tokenName).toEqual("AGG Token");
    expect(result.decimals).toEqual(8);
    expect(result.maxSupply).toEqual("10000000");
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
