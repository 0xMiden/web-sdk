// @ts-nocheck
import { test, expect } from "./test-setup";

// new_wallet tests
// =======================================================================================================

test.describe("new_wallet tests", () => {
  test("creates a new private, immutable wallet", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const newWallet = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      return {
        id: newWallet.id().toString(),
        nonce: newWallet.nonce().toString(),
        vaultRoot: newWallet.vault().root().toHex(),
        storageCommitment: newWallet.storage().commitment().toHex(),
        codeCommitment: newWallet.code().commitment().toHex(),
        isFaucet: newWallet.isFaucet(),
        isRegularAccount: newWallet.isRegularAccount(),
        isPublic: newWallet.isPublic(),
        isPrivate: newWallet.isPrivate(),
        idIsPublic: newWallet.id().isPublic(),
        idIsPrivate: newWallet.id().isPrivate(),
        isNew: newWallet.isNew(),
      };
    });
    expect(result.id.startsWith("0x")).toBe(true);
    expect(result.nonce).toEqual("0");
    expect(result.vaultRoot.startsWith("0x")).toBe(true);
    expect(result.storageCommitment.startsWith("0x")).toBe(true);
    expect(result.codeCommitment.startsWith("0x")).toBe(true);
    expect(result.isFaucet).toEqual(false);
    expect(result.isRegularAccount).toEqual(true);
    expect(result.isPublic).toEqual(false);
    expect(result.isPrivate).toEqual(true);
    expect(result.idIsPublic).toEqual(false);
    expect(result.idIsPrivate).toEqual(true);
    expect(result.isNew).toEqual(true);
  });

  test("creates a new public, immutable wallet", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const newWallet = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      return {
        id: newWallet.id().toString(),
        nonce: newWallet.nonce().toString(),
        vaultRoot: newWallet.vault().root().toHex(),
        storageCommitment: newWallet.storage().commitment().toHex(),
        codeCommitment: newWallet.code().commitment().toHex(),
        isFaucet: newWallet.isFaucet(),
        isRegularAccount: newWallet.isRegularAccount(),
        isPublic: newWallet.isPublic(),
        isPrivate: newWallet.isPrivate(),
        idIsPublic: newWallet.id().isPublic(),
        idIsPrivate: newWallet.id().isPrivate(),
        isNew: newWallet.isNew(),
      };
    });
    expect(result.id.startsWith("0x")).toBe(true);
    expect(result.nonce).toEqual("0");
    expect(result.vaultRoot.startsWith("0x")).toBe(true);
    expect(result.storageCommitment.startsWith("0x")).toBe(true);
    expect(result.codeCommitment.startsWith("0x")).toBe(true);
    expect(result.isFaucet).toEqual(false);
    expect(result.isRegularAccount).toEqual(true);
    expect(result.isPublic).toEqual(true);
    expect(result.isPrivate).toEqual(false);
    expect(result.idIsPublic).toEqual(true);
    expect(result.idIsPrivate).toEqual(false);
    expect(result.isNew).toEqual(true);
  });

  test("creates a new private, mutable wallet", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const newWallet = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      return {
        id: newWallet.id().toString(),
        nonce: newWallet.nonce().toString(),
        vaultRoot: newWallet.vault().root().toHex(),
        storageCommitment: newWallet.storage().commitment().toHex(),
        codeCommitment: newWallet.code().commitment().toHex(),
        isFaucet: newWallet.isFaucet(),
        isRegularAccount: newWallet.isRegularAccount(),
        isPublic: newWallet.isPublic(),
        isPrivate: newWallet.isPrivate(),
        idIsPublic: newWallet.id().isPublic(),
        idIsPrivate: newWallet.id().isPrivate(),
        isNew: newWallet.isNew(),
      };
    });
    expect(result.id.startsWith("0x")).toBe(true);
    expect(result.nonce).toEqual("0");
    expect(result.vaultRoot.startsWith("0x")).toBe(true);
    expect(result.storageCommitment.startsWith("0x")).toBe(true);
    expect(result.codeCommitment.startsWith("0x")).toBe(true);
    expect(result.isFaucet).toEqual(false);
    expect(result.isRegularAccount).toEqual(true);
    expect(result.isPublic).toEqual(false);
    expect(result.isPrivate).toEqual(true);
    expect(result.idIsPublic).toEqual(false);
    expect(result.idIsPrivate).toEqual(true);
    expect(result.isNew).toEqual(true);
  });

  test("creates a new public, mutable wallet", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const newWallet = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      return {
        id: newWallet.id().toString(),
        nonce: newWallet.nonce().toString(),
        vaultRoot: newWallet.vault().root().toHex(),
        storageCommitment: newWallet.storage().commitment().toHex(),
        codeCommitment: newWallet.code().commitment().toHex(),
        isFaucet: newWallet.isFaucet(),
        isRegularAccount: newWallet.isRegularAccount(),
        isPublic: newWallet.isPublic(),
        isPrivate: newWallet.isPrivate(),
        idIsPublic: newWallet.id().isPublic(),
        idIsPrivate: newWallet.id().isPrivate(),
        isNew: newWallet.isNew(),
      };
    });
    expect(result.id.startsWith("0x")).toBe(true);
    expect(result.nonce).toEqual("0");
    expect(result.vaultRoot.startsWith("0x")).toBe(true);
    expect(result.storageCommitment.startsWith("0x")).toBe(true);
    expect(result.codeCommitment.startsWith("0x")).toBe(true);
    expect(result.isFaucet).toEqual(false);
    expect(result.isRegularAccount).toEqual(true);
    expect(result.isPublic).toEqual(true);
    expect(result.isPrivate).toEqual(false);
    expect(result.idIsPublic).toEqual(true);
    expect(result.idIsPrivate).toEqual(false);
    expect(result.isNew).toEqual(true);
  });
});

// new_faucet tests
// =======================================================================================================
test.describe("new_faucet tests", () => {
  test("creates a new private, fungible faucet", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const newFaucet = await client.newFaucet(
        sdk.AccountStorageMode.private(),
        false,
        "DAG",
        "DAG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      return {
        id: newFaucet.id().toString(),
        nonce: newFaucet.nonce().toString(),
        vaultRoot: newFaucet.vault().root().toHex(),
        storageCommitment: newFaucet.storage().commitment().toHex(),
        codeCommitment: newFaucet.code().commitment().toHex(),
        isFaucet: newFaucet.isFaucet(),
        isRegularAccount: newFaucet.isRegularAccount(),
        isPublic: newFaucet.isPublic(),
        isPrivate: newFaucet.isPrivate(),
        idIsPublic: newFaucet.id().isPublic(),
        idIsPrivate: newFaucet.id().isPrivate(),
        isNew: newFaucet.isNew(),
      };
    });
    expect(result.id.startsWith("0x")).toBe(true);
    expect(result.nonce).toEqual("0");
    expect(result.vaultRoot.startsWith("0x")).toBe(true);
    expect(result.storageCommitment.startsWith("0x")).toBe(true);
    expect(result.codeCommitment.startsWith("0x")).toBe(true);
    expect(result.isFaucet).toEqual(true);
    expect(result.isRegularAccount).toEqual(false);
    expect(result.isPublic).toEqual(false);
    expect(result.isPrivate).toEqual(true);
    expect(result.idIsPublic).toEqual(false);
    expect(result.idIsPrivate).toEqual(true);
    expect(result.isNew).toEqual(true);
  });

  test("creates a new public, fungible faucet", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const newFaucet = await client.newFaucet(
        sdk.AccountStorageMode.public(),
        false,
        "DAG",
        "DAG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      return {
        id: newFaucet.id().toString(),
        nonce: newFaucet.nonce().toString(),
        vaultRoot: newFaucet.vault().root().toHex(),
        storageCommitment: newFaucet.storage().commitment().toHex(),
        codeCommitment: newFaucet.code().commitment().toHex(),
        isFaucet: newFaucet.isFaucet(),
        isRegularAccount: newFaucet.isRegularAccount(),
        isPublic: newFaucet.isPublic(),
        isPrivate: newFaucet.isPrivate(),
        idIsPublic: newFaucet.id().isPublic(),
        idIsPrivate: newFaucet.id().isPrivate(),
        isNew: newFaucet.isNew(),
      };
    });
    expect(result.id.startsWith("0x")).toBe(true);
    expect(result.nonce).toEqual("0");
    expect(result.vaultRoot.startsWith("0x")).toBe(true);
    expect(result.storageCommitment.startsWith("0x")).toBe(true);
    expect(result.codeCommitment.startsWith("0x")).toBe(true);
    expect(result.isFaucet).toEqual(true);
    expect(result.isRegularAccount).toEqual(false);
    expect(result.isPublic).toEqual(true);
    expect(result.isPrivate).toEqual(false);
    expect(result.idIsPublic).toEqual(true);
    expect(result.idIsPrivate).toEqual(false);
    expect(result.isNew).toEqual(true);
  });

  test("throws an error when attempting to create a non-fungible faucet", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      try {
        await client.newFaucet(
          sdk.AccountStorageMode.public(),
          true,
          "DAG",
          "DAG",
          8,
          sdk.u64(10000000),
          sdk.AuthScheme.AuthRpoFalcon512
        );
        return { threw: false, errorMessage: "" };
      } catch (e) {
        return { threw: true, errorMessage: e.message || String(e) };
      }
    });
    expect(result.threw).toBe(true);
    expect(result.errorMessage).toContain(
      "Non-fungible faucets are not supported yet"
    );
  });

  test("throws an error when attempting to create a faucet with an invalid token symbol", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      try {
        await client.newFaucet(
          sdk.AccountStorageMode.public(),
          false,
          "INVALID_TOKEN",
          "INVALID_TOKEN",
          8,
          sdk.u64(10000000),
          sdk.AuthScheme.AuthRpoFalcon512
        );
        return { threw: false, errorMessage: "" };
      } catch (e) {
        return { threw: true, errorMessage: e.message || String(e) };
      }
    });
    expect(result.threw).toBe(true);
    expect(result.errorMessage).toContain(
      "token symbol should have length between 1 and 12 characters, but 13 was provided"
    );
  });
});

// newAccount network fee-faucet check (#408)
// =======================================================================================================

test.describe("newAccount network fee faucet", () => {
  test("rejects a network account built with the wrong fee faucet and accepts the chain's", async ({
    run,
  }) => {
    // Issue #408: exercise the check on the mock chain, not a live node fixture.
    const result = await run(async ({ sdk, helpers }) => {
      const client = await helpers.createFreshMockClient();
      await client.syncState();
      const chainFee = await client.feeFaucetId();
      const wrongFaucet = await client.newFaucet(
        sdk.AccountStorageMode.public(),
        false,
        "WRG",
        "WRG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const wrongComponents = sdk.AccountComponent.createNetworkAuthComponents(
        [new sdk.NoteScriptFee(sdk.NoteScript.p2id().root(), sdk.u64(0))],
        wrongFaucet.id()
      );
      const wrongSeed = new Uint8Array(32);
      wrongSeed.fill(0x41);
      const wrongBuilder = new sdk.AccountBuilder(wrongSeed).storageMode(
        sdk.AccountStorageMode.public()
      );
      for (const component of wrongComponents) {
        wrongBuilder.withComponent(component);
      }
      const wrongAccount = wrongBuilder.build().account;

      let rejected = false;
      let errorMessage = "";
      try {
        await client.newAccount(wrongAccount, false);
      } catch (e) {
        rejected = true;
        errorMessage = e.message || String(e);
      }

      const okComponents = sdk.AccountComponent.createNetworkAuthComponents(
        [new sdk.NoteScriptFee(sdk.NoteScript.p2id().root(), sdk.u64(0))],
        chainFee
      );
      const okSeed = new Uint8Array(32);
      okSeed.fill(0x42);
      const okBuilder = new sdk.AccountBuilder(okSeed).storageMode(
        sdk.AccountStorageMode.public()
      );
      for (const component of okComponents) {
        okBuilder.withComponent(component);
      }
      const okAccount = okBuilder.build().account;
      await client.newAccount(okAccount, false);

      return {
        rejected,
        errorMessage,
        namesChainFee: errorMessage.includes(chainFee.toString()),
        namesWrongFaucet: errorMessage.includes(wrongFaucet.id().toString()),
        okInserted: (await client.getAccount(okAccount.id())) != null,
      };
    });

    expect(result.rejected).toBe(true);
    expect(result.errorMessage).toContain(
      "does not match the chain's fee faucet"
    );
    expect(result.namesChainFee).toBe(true);
    expect(result.namesWrongFaucet).toBe(true);
    expect(result.okInserted).toBe(true);
  });
});

// AccountStorage.getMapEntries tests
// =======================================================================================================

test.describe("AccountStorage.getMapEntries tests", () => {
  test("returns undefined for invalid slot names", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const NON_MAP_SLOT_NAME =
        "miden::standards::auth::rpo_falcon512::public_key";
      const MISSING_SLOT_NAME =
        "miden::testing::account_storage_tests::missing";

      const account = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const accountRecord = await client.getAccount(account.id());

      const storage = accountRecord.storage();

      const nonMapResult = storage.getMapEntries(NON_MAP_SLOT_NAME);
      const missingSlotResult = storage.getMapEntries(MISSING_SLOT_NAME);

      return {
        accountRecordDefined: accountRecord !== undefined,
        nonMapResultUndefined: nonMapResult === undefined,
        missingSlotResultUndefined: missingSlotResult === undefined,
      };
    });
    expect(result.accountRecordDefined).toBe(true);
    expect(result.nonMapResultUndefined).toBe(true);
    expect(result.missingSlotResultUndefined).toBe(true);
  });
});
