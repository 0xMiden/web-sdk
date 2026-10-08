// @ts-nocheck
import { test, expect } from "./test-setup";

// GET_ACCOUNT TESTS
// =======================================================================================================

test.describe("get_account tests", () => {
  test("retrieves an existing account", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const newAccount = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const retrieved = await client.getAccount(newAccount.id());

      return {
        isTruthy: !!retrieved,
        retrievedCommitment: retrieved.to_commitment().toHex(),
        newAccountCommitment: newAccount.to_commitment().toHex(),
      };
    });
    expect(result.isTruthy).toBe(true);
    expect(result.retrievedCommitment).toEqual(result.newAccountCommitment);
  });

  test("returns undefined attempting to retrieve a non-existing account", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const nonExistingAccountId = sdk.AccountId.fromHex(
        "0x69817bcc6fb9f99127c2245f6979c5"
      );

      const retrieved = await client.getAccount(nonExistingAccountId);

      return { isUndefined: retrieved === undefined };
    });
    expect(result.isUndefined).toBe(true);
  });
});

// GET_ACCOUNTS TESTS
// =======================================================================================================

test.describe("getAccounts tests", () => {
  test("retrieves all existing accounts", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const newAccount1 = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const newAccount2 = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const commitmentsOfCreatedAccounts = [
        newAccount1.to_commitment().toHex(),
        newAccount2.to_commitment().toHex(),
      ];

      const accounts = await client.getAccounts();

      const commitmentsOfGetAccountsResult = [];
      for (let i = 0; i < accounts.length; i++) {
        commitmentsOfGetAccountsResult.push(
          accounts[i].to_commitment().toHex()
        );
      }

      return {
        commitmentsOfCreatedAccounts,
        commitmentsOfGetAccountsResult,
        resultLength: accounts.length,
      };
    });

    for (const address of result.commitmentsOfGetAccountsResult) {
      expect(result.commitmentsOfCreatedAccounts.includes(address)).toBe(true);
    }
    expect(result.resultLength).toBe(2);
  });

  test("returns empty array when no accounts exist", async ({ run }) => {
    const result = await run(async ({ client }) => {
      const accounts = await client.getAccounts();
      return { length: accounts.length };
    });
    expect(result.length).toEqual(0);
  });
});

// GET PUBLIC ACCOUNT WITH DETAILS
// =======================================================================================================

test.describe("get public account with details", () => {
  test("assets and storage with too many assets/entries are retrieved", async ({
    run,
  }) => {
    test.skip(
      true,
      "Temporarily skipped: node returns Internal error for large genesis account"
    );
  });
});

// ACCOUNT PUBLIC COMMITMENTS
// =======================================================================================================

test.describe("account public commitments", () => {
  test("properly stores public commitments", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const newAccount = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const accountId = newAccount.id();

      const sk1 = sdk.AuthSecretKey.ecdsaWithRNG(null);
      const sk2 = sdk.AuthSecretKey.rpoFalconWithRNG(null);

      await client.keystore.insert(accountId, sk1);
      await client.keystore.insert(accountId, sk2);

      const commitments = await client.keystore.getCommitments(accountId);

      return { commitmentsLength: commitments.length };
    });
    expect(result.commitmentsLength).toBe(3);
  });

  test("retrieve auth keys with pk commitments and verify signatures", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const accountId = sdk.AccountId.fromHex(
        "0x69817bcc6fb9f99127c2245f6979c5"
      );

      const sk1 = sdk.AuthSecretKey.ecdsaWithRNG(null);
      const sk2 = sdk.AuthSecretKey.rpoFalconWithRNG(null);
      const sk3 = sdk.AuthSecretKey.rpoFalconWithRNG(null);

      await client.keystore.insert(accountId, sk1);
      await client.keystore.insert(accountId, sk2);
      await client.keystore.insert(accountId, sk3);

      const commitments = await client.keystore.getCommitments(accountId);

      let sk1Retrieved = false;
      let sk2Retrieved = false;
      let sk3Retrieved = false;

      const message = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const signingInputs = sdk.SigningInputs.newBlind(message);

      for (const commitment of commitments) {
        const retrievedSk = await client.keystore.get(commitment);
        const signature = retrievedSk.signData(signingInputs);

        sk1Retrieved =
          sk1Retrieved || sk1.publicKey().verify(message, signature);
        sk2Retrieved =
          sk2Retrieved || sk2.publicKey().verify(message, signature);
        sk3Retrieved =
          sk3Retrieved || sk3.publicKey().verify(message, signature);
      }
      return { allRetrieved: sk1Retrieved && sk2Retrieved && sk3Retrieved };
    });
    expect(result.allRetrieved).toBe(true);
  });

  test("non-registered account id does not have any commitments", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const accountId = sdk.AccountId.fromHex(
        "0x69817bcc6fb9f99127c2245f6979c5"
      );
      let commitmentsLength;
      try {
        const commitments = await client.keystore.getCommitments(accountId);
        commitmentsLength = commitments.length;
      } catch (e) {
        // On napi (SQLite), querying commitments for an account not in the store
        // throws "account not found" instead of returning an empty array.
        if (e.message?.includes("account not found")) {
          commitmentsLength = 0;
        } else {
          throw e;
        }
      }
      return { commitmentsLength };
    });
    expect(result.commitmentsLength).toBe(0);
  });

  test("can retrieve pk commitment after wallet creation", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const account = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const commitments = await client.keystore.getCommitments(account.id());
      return { commitmentsLength: commitments.length };
    });
    expect(result.commitmentsLength).toBe(1);
  });

  test("separate account ids get their respective pk commitments", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const accountId1 = sdk.AccountId.fromHex(
        "0x69817bcc6fb9f99127c2245f6979c5"
      );

      const sk1 = sdk.AuthSecretKey.ecdsaWithRNG(null);
      const sk2 = sdk.AuthSecretKey.rpoFalconWithRNG(null);

      await client.keystore.insert(accountId1, sk1);
      await client.keystore.insert(accountId1, sk2);

      const account1Commitments =
        await client.keystore.getCommitments(accountId1);

      const accountId2 = sdk.AccountId.fromHex(
        "0x79817bcc6fb9f99127c2245f6979ef"
      );

      const sk3 = sdk.AuthSecretKey.rpoFalconWithRNG(null);

      await client.keystore.insert(accountId2, sk3);

      const account2Commitments =
        await client.keystore.getCommitments(accountId2);

      return {
        account1CommitmentsLength: account1Commitments.length,
        account2CommitmentsLength: account2Commitments.length,
      };
    });
    expect(result.account1CommitmentsLength).toBe(2);
    expect(result.account2CommitmentsLength).toBe(1);
  });
});

// GET_PUBLIC_KEY_COMMITMENTS TESTS
// =======================================================================================================

test.describe("Account.getPublicKeyCommitments", () => {
  test("returns the key for a standard auth component", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const wallet = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      return { count: wallet.getPublicKeyCommitments().length };
    });
    expect(result.count).toBe(1);
  });

  test("returns every approver key for an SDK-built multisig", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const approvers = [1, 2, 3].map(
        (n) => new sdk.Word(sdk.u64Array([n, 0, 0, 0]))
      );
      // The config takes the approver words by value, so read them first.
      const expected = approvers.map((word) => word.toHex()).sort();
      const config = new sdk.AuthFalcon512RpoMultisigConfig(approvers, 2);
      const seed = new Uint8Array(32);
      seed.fill(0x21);
      const account = new sdk.AccountBuilder(seed)
        .withAuthComponent(sdk.createAuthFalcon512RpoMultisig(config))
        .withBasicWalletComponent()
        .storageMode(sdk.AccountStorageMode.public())
        .build().account;
      return {
        expected,
        keys: account
          .getPublicKeyCommitments()
          .map((word) => word.toHex())
          .sort(),
      };
    });
    expect(result.keys).toEqual(result.expected);
  });

  test("returns every approver key for a createAuthGuardedMultisig account", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const approvers = [4, 5].map(
        (n) => new sdk.Word(sdk.u64Array([n, 0, 0, 0]))
      );
      const expected = approvers.map((word) => word.toHex()).sort();
      const guardian = new sdk.Word(sdk.u64Array([6, 0, 0, 0]));
      const config = new sdk.AuthGuardedMultisigConfig(
        approvers,
        2,
        guardian,
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const seed = new Uint8Array(32);
      seed.fill(0x22);
      const account = new sdk.AccountBuilder(seed)
        .withAuthComponent(sdk.createAuthGuardedMultisig(config))
        .withBasicWalletComponent()
        .storageMode(sdk.AccountStorageMode.public())
        .build().account;
      return {
        expected,
        keys: account
          .getPublicKeyCommitments()
          .map((word) => word.toHex())
          .sort(),
      };
    });
    expect(result.keys).toEqual(result.expected);
  });

  test("returns the key for an ECDSA single-sig wallet", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const wallet = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthEcdsaK256Keccak
      );
      return { count: wallet.getPublicKeyCommitments().length };
    });
    expect(result.count).toBe(1);
  });

  test("returns no keys for a network account", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const components = sdk.AccountComponent.createNetworkAuthComponents(
        [new sdk.NoteScriptFee(sdk.NoteScript.p2id().root(), sdk.u64(0))],
        await client.feeFaucetId()
      );
      const seed = new Uint8Array(32);
      seed.fill(0x31);
      const builder = new sdk.AccountBuilder(seed).storageMode(
        sdk.AccountStorageMode.public()
      );
      for (const component of components) {
        builder.withComponent(component);
      }
      const account = builder.build().account;
      return {
        isNetworkAccount: account.isNetworkAccount(),
        count: account.getPublicKeyCommitments().length,
      };
    });
    expect(result.isNetworkAccount).toBe(true);
    expect(result.count).toBe(0);
  });

  test("returns no keys for a NoAuth account", async ({ run }) => {
    const result = await run(async ({ sdk }) => {
      const seed = new Uint8Array(32);
      seed.fill(0x23);
      const account = new sdk.AccountBuilder(seed)
        .withNoAuthComponent()
        .withBasicWalletComponent()
        .storageMode(sdk.AccountStorageMode.public())
        .build().account;
      return { count: account.getPublicKeyCommitments().length };
    });
    expect(result.count).toBe(0);
  });

  test("throws when a deserialized multisig claims more approvers than it stores", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const approvers = [11, 12, 13].map(
        (n) => new sdk.Word(sdk.u64Array([n, 0, 0, 0]))
      );
      const config = new sdk.AuthFalcon512RpoMultisigConfig(approvers, 2);
      const seed = new Uint8Array(32);
      seed.fill(0x28);
      const honest = new sdk.AccountBuilder(seed)
        .withAuthComponent(sdk.createAuthFalcon512RpoMultisig(config))
        .withBasicWalletComponent()
        .storageMode(sdk.AccountStorageMode.public())
        .build().account;

      // The threshold config slot serializes as its name (length byte, then bytes),
      // the value slot type 0, and the [threshold, approvers, 0, 0] word as
      // little-endian u64s. Raise the approver count far above the three stored keys.
      const bytes = Uint8Array.from(honest.serialize());
      const view = new DataView(bytes.buffer);
      const name = new TextEncoder().encode(
        "miden::standards::auth::multisig::threshold_config"
      );
      const configWords = [];
      for (let i = 0; i + name.length + 18 <= bytes.length; i++) {
        const word = i + name.length + 2;
        if (
          bytes[i] === name.length &&
          name.every((byte, j) => bytes[i + 1 + j] === byte) &&
          bytes[word - 1] === 0 &&
          view.getBigUint64(word, true) === 2n &&
          view.getBigUint64(word + 8, true) === 3n
        ) {
          configWords.push(word);
        }
      }
      if (configWords.length === 1) {
        view.setBigUint64(configWords[0] + 8, 1000000000n, true);
      }

      // The account ends with the nonce (a u64) and the seed Option (tag 1, then a
      // 32-byte word). A non-zero nonce with no seed is how an account already on
      // chain serializes, and deserialize then skips the seed check.
      const seedTag = bytes[bytes.length - 33];
      const crafted = bytes.slice(0, bytes.length - 32);
      new DataView(crafted.buffer).setBigUint64(crafted.length - 9, 1n, true);
      crafted[crafted.length - 1] = 0;

      let account = null;
      let deserializeError = null;
      try {
        account = sdk.Account.deserialize(crafted);
      } catch (err) {
        deserializeError = err?.message ?? String(err);
      }

      let keys = null;
      let error = null;
      if (account) {
        try {
          keys = account.getPublicKeyCommitments().length;
        } catch (err) {
          error = err?.message ?? String(err);
        }
      }

      return {
        configWords: configWords.length,
        seedTag,
        deserializeError,
        keys,
        error,
      };
    });

    expect(result.configWords).toBe(1);
    expect(result.seedTag).toBe(1);
    expect(result.deserializeError).toBeNull();
    expect(result.keys).toBeNull();
    expect(result.error).toContain("declares 1000000000 approvers");
    expect(result.error).toContain("holds 3 entries");
  });

  test("throws when a multisig keeps its approver keys outside a map", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const approvers = [14, 15].map(
        (n) => new sdk.Word(sdk.u64Array([n, 0, 0, 0]))
      );
      const multisig = sdk.createAuthFalcon512RpoMultisig(
        new sdk.AuthFalcon512RpoMultisigConfig(approvers, 1)
      );
      // The SDK multisig's own code with storage that claims a billion approvers and
      // holds the approver keys in a value slot instead of a map.
      const forged = sdk.AccountComponent.compile(multisig.componentCode(), [
        sdk.StorageSlot.fromValue(
          "miden::standards::auth::multisig::threshold_config",
          new sdk.Word(sdk.u64Array([1, 1000000000, 0, 0]))
        ),
        sdk.StorageSlot.fromValue(
          "miden::standards::auth::multisig::approver_public_keys",
          new sdk.Word(sdk.u64Array([14, 0, 0, 0]))
        ),
      ]).withSupportsAllTypes();
      const seed = new Uint8Array(32);
      seed.fill(0x29);
      const built = new sdk.AccountBuilder(seed)
        .withAuthComponent(forged)
        .withBasicWalletComponent()
        .storageMode(sdk.AccountStorageMode.public())
        .build().account;

      let account = null;
      let deserializeError = null;
      try {
        account = sdk.Account.deserialize(built.serialize());
      } catch (err) {
        deserializeError = err?.message ?? String(err);
      }

      let keys = null;
      let error = null;
      if (account) {
        try {
          keys = account.getPublicKeyCommitments().length;
        } catch (err) {
          error = err?.message ?? String(err);
        }
      }

      return { deserializeError, keys, error };
    });

    expect(result.deserializeError).toBeNull();
    expect(result.keys).toBeNull();
    expect(result.error).toContain("declares 1000000000 approvers");
    expect(result.error).toContain("holds 0 entries");
  });

  test("throws for a non-standard auth component", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      // An auth component compiled from arbitrary MASM: its auth procedure matches no
      // bundled standard template, so classification names it a `CustomAuth`
      // component. Same shape as any third-party auth component that defines its own
      // key storage layout.
      const code = `
        @auth_script
        pub proc auth_noop
            push.1 drop
        end
      `;
      const codeBuilder = await client.createCodeBuilder();
      const library = codeBuilder.buildLibrary("custom::auth::noop", code);
      const authComponent = sdk.AccountComponent.fromLibrary(
        library,
        []
      ).withSupportsAllTypes();

      const seed = new Uint8Array(32);
      seed.fill(0x07);
      const account = new sdk.AccountBuilder(seed)
        .withAuthComponent(authComponent)
        .withBasicWalletComponent()
        .storageMode(sdk.AccountStorageMode.public())
        .build().account;

      let error = null;
      try {
        account.getPublicKeyCommitments();
      } catch (err) {
        error = err?.message ?? String(err);
      }

      // The custom auth component leaves the rest of the classification intact.
      return { error, isFaucet: account.isFaucet() };
    });

    expect(result.error).toContain(
      "not owned by exactly one standard auth component"
    );
    expect(result.error).toContain("client.keystore.getCommitments(accountId)");
    expect(result.error).toContain("different miden-standards revision");
    expect(result.error).toContain("AccountComponent.compile");
    expect(result.error).toContain("createAuthGuardedMultisig");
    expect(result.isFaucet).toBe(false);
  });

  test("throws without trapping when a second standard auth procedure is installed", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      // NoAuth's auth procedure body from miden-standards, exported as an ordinary
      // `@account_procedure` rather than `@auth_script`, so it compiles to the same
      // MAST root as the standard NoAuth procedure. Next to a real single-sig auth
      // component, classification then finds two standard auth components.
      const code = `
        use {AuthArgs} from miden::standards::types
        use miden::protocol::active_account
        use miden::protocol::native_account
        use miden::protocol::tx
        use miden::standards::fee

        const NO_AUTH_POST_FEE_CYCLES = 1024

        @account_procedure
        pub proc auth_no_auth(auth_args: AuthArgs)
            dropw
            exec.fee::native_conversion_info
            push.NO_AUTH_POST_FEE_CYCLES
            exec.tx::get_reference_block_number movdn.5
            exec.fee::pay_fee drop
            exec.native_account::has_state_changed
            exec.active_account::get_nonce eq.0
            or
            if.true
                exec.native_account::incr_nonce drop
            end
        end
      `;
      const codeBuilder = await client.createCodeBuilder();
      const library = codeBuilder.buildLibrary("custom::lookalike", code);
      const lookalike = sdk.AccountComponent.fromLibrary(
        library,
        []
      ).withSupportsAllTypes();

      const noAuthSeed = new Uint8Array(32);
      noAuthSeed.fill(0x24);
      const noAuthAccount = new sdk.AccountBuilder(noAuthSeed)
        .withNoAuthComponent()
        .withBasicWalletComponent()
        .storageMode(sdk.AccountStorageMode.public())
        .build().account;
      const sameRootAsNoAuth = noAuthAccount
        .code()
        .hasProcedure(
          sdk.Word.fromHex(lookalike.getProcedureHash("auth_no_auth"))
        );

      const singleSig = sdk.AccountComponent.createAuthComponentFromCommitment(
        new sdk.Word(sdk.u64Array([7, 0, 0, 0])),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const seed = new Uint8Array(32);
      seed.fill(0x25);
      const account = new sdk.AccountBuilder(seed)
        .withAuthComponent(singleSig)
        .withComponent(lookalike)
        .withBasicWalletComponent()
        .storageMode(sdk.AccountStorageMode.public())
        .build().account;

      let isFaucet = null;
      let isFaucetError = null;
      try {
        isFaucet = account.isFaucet();
      } catch (err) {
        isFaucetError = err?.message ?? String(err);
      }

      let error = null;
      try {
        account.getPublicKeyCommitments();
      } catch (err) {
        error = err?.message ?? String(err);
      }

      return { sameRootAsNoAuth, isFaucet, isFaucetError, error };
    });

    expect(result.sameRootAsNoAuth).toBe(true);
    expect(result.isFaucetError).toBeNull();
    expect(result.isFaucet).toBe(false);
    expect(result.error).toContain(
      "not owned by exactly one standard auth component"
    );
  });

  test("throws when the auth procedure is custom and a standard auth body sits elsewhere", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      // A custom auth procedure at index 0, plus an ordinary component exporting
      // NoAuth's auth procedure body. Classification matches NoAuth on that body, so
      // only the index-0 root left in the custom bucket shows that no standard
      // component owns the auth procedure.
      const lookalikeCode = `
        use {AuthArgs} from miden::standards::types
        use miden::protocol::active_account
        use miden::protocol::native_account
        use miden::protocol::tx
        use miden::standards::fee

        const NO_AUTH_POST_FEE_CYCLES = 1024

        @account_procedure
        pub proc auth_no_auth(auth_args: AuthArgs)
            dropw
            exec.fee::native_conversion_info
            push.NO_AUTH_POST_FEE_CYCLES
            exec.tx::get_reference_block_number movdn.5
            exec.fee::pay_fee drop
            exec.native_account::has_state_changed
            exec.active_account::get_nonce eq.0
            or
            if.true
                exec.native_account::incr_nonce drop
            end
        end
      `;
      const authCode = `
        @auth_script
        pub proc auth_noop
            push.1 drop
        end
      `;
      const codeBuilder = await client.createCodeBuilder();
      const lookalike = sdk.AccountComponent.fromLibrary(
        codeBuilder.buildLibrary("custom::lookalike", lookalikeCode),
        []
      ).withSupportsAllTypes();
      const authComponent = sdk.AccountComponent.fromLibrary(
        codeBuilder.buildLibrary("custom::auth::noop", authCode),
        []
      ).withSupportsAllTypes();

      const noAuthSeed = new Uint8Array(32);
      noAuthSeed.fill(0x26);
      const noAuthAccount = new sdk.AccountBuilder(noAuthSeed)
        .withNoAuthComponent()
        .withBasicWalletComponent()
        .storageMode(sdk.AccountStorageMode.public())
        .build().account;
      const sameRootAsNoAuth = noAuthAccount
        .code()
        .hasProcedure(
          sdk.Word.fromHex(lookalike.getProcedureHash("auth_no_auth"))
        );

      const seed = new Uint8Array(32);
      seed.fill(0x27);
      const account = new sdk.AccountBuilder(seed)
        .withAuthComponent(authComponent)
        .withComponent(lookalike)
        .withBasicWalletComponent()
        .storageMode(sdk.AccountStorageMode.public())
        .build().account;

      let keys = null;
      let error = null;
      try {
        keys = account.getPublicKeyCommitments().length;
      } catch (err) {
        error = err?.message ?? String(err);
      }

      return { sameRootAsNoAuth, keys, error };
    });

    expect(result.sameRootAsNoAuth).toBe(true);
    expect(result.keys).toBeNull();
    expect(result.error).toContain(
      "not owned by exactly one standard auth component"
    );
  });

  test("throws when the auth procedure copies NoteCreator's create_note and a NoAuth body sits elsewhere", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      // An @auth_script procedure with create_note's body, so with no BasicWallet installed
      // the NoteCreator component claims the auth root, plus NoAuth's auth body exported as
      // an ordinary procedure that classifies as the only auth component.
      const authCode = `
        use {NoteRecipient, NoteTag, NoteType} from miden::protocol::types
        use miden::protocol::output_note

        @auth_script
        pub proc auth_create_note(tag: NoteTag, note_type: NoteType, recipient: NoteRecipient) -> u16
            exec.output_note::create
        end
      `;
      const lookalikeCode = `
        use {AuthArgs} from miden::standards::types
        use miden::protocol::active_account
        use miden::protocol::native_account
        use miden::protocol::tx
        use miden::standards::fee

        const NO_AUTH_POST_FEE_CYCLES = 1024

        @account_procedure
        pub proc auth_no_auth(auth_args: AuthArgs)
            dropw
            exec.fee::native_conversion_info
            push.NO_AUTH_POST_FEE_CYCLES
            exec.tx::get_reference_block_number movdn.5
            exec.fee::pay_fee drop
            exec.native_account::has_state_changed
            exec.active_account::get_nonce eq.0
            or
            if.true
                exec.native_account::incr_nonce drop
            end
        end
      `;
      const codeBuilder = await client.createCodeBuilder();
      const authComponent = sdk.AccountComponent.fromLibrary(
        codeBuilder.buildLibrary("custom::auth::create_note", authCode),
        []
      ).withSupportsAllTypes();
      const lookalike = sdk.AccountComponent.fromLibrary(
        codeBuilder.buildLibrary("custom::lookalike", lookalikeCode),
        []
      ).withSupportsAllTypes();

      // A NoAuth wallet carries both standard roots the crafted procedures must match.
      const walletSeed = new Uint8Array(32);
      walletSeed.fill(0x2a);
      const wallet = new sdk.AccountBuilder(walletSeed)
        .withNoAuthComponent()
        .withBasicWalletComponent()
        .storageMode(sdk.AccountStorageMode.public())
        .build().account;
      const authIsCreateNote = wallet
        .code()
        .hasProcedure(
          sdk.Word.fromHex(authComponent.getProcedureHash("auth_create_note"))
        );
      const lookalikeIsNoAuth = wallet
        .code()
        .hasProcedure(
          sdk.Word.fromHex(lookalike.getProcedureHash("auth_no_auth"))
        );

      let account = null;
      let buildError = null;
      try {
        const seed = new Uint8Array(32);
        seed.fill(0x2b);
        account = new sdk.AccountBuilder(seed)
          .withAuthComponent(authComponent)
          .withComponent(lookalike)
          .storageMode(sdk.AccountStorageMode.public())
          .build().account;
      } catch (err) {
        buildError = err?.message ?? String(err);
      }

      let keys = null;
      let error = null;
      if (account) {
        try {
          keys = account.getPublicKeyCommitments().length;
        } catch (err) {
          error = err?.message ?? String(err);
        }
      }

      return { authIsCreateNote, lookalikeIsNoAuth, buildError, keys, error };
    });

    expect(result.authIsCreateNote).toBe(true);
    expect(result.lookalikeIsNoAuth).toBe(true);
    expect(result.buildError).toBeNull();
    expect(result.keys).toBeNull();
    expect(result.error).toContain(
      "not owned by exactly one standard auth component"
    );
  });

  test("throws when the auth procedure copies NoteCreator's create_note and a single-sig body sits elsewhere", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      // As above, with the single-sig auth body (and a planted public key in its slot) as
      // the ordinary procedure that classifies as the only auth component.
      const authCode = `
        use {NoteRecipient, NoteTag, NoteType} from miden::protocol::types
        use miden::protocol::output_note

        @auth_script
        pub proc auth_create_note(tag: NoteTag, note_type: NoteType, recipient: NoteRecipient) -> u16
            exec.output_note::create
        end
      `;
      const lookalikeCode = `
        use miden::standards::auth::signature
        use miden::standards::fee
        use miden::protocol::native_account
        use miden::protocol::tx

        const PUBLIC_KEY_COMMITMENT_SLOT = word("miden::standards::auth::singlesig::pub_key")
        const SCHEME_ID_SLOT = word("miden::standards::auth::singlesig::scheme")

        @account_procedure
        pub proc auth_tx(auth_args: word)
            exec.fee::load_conversion_info
            push.SCHEME_ID_SLOT[0..2] exec.native_account::get_initial_item
            movdn.3 drop drop drop
            dup exec.signature::estimate_authentication_cycles
            swap movdn.5
            exec.tx::get_reference_block_number movdn.5
            exec.fee::pay_fee drop
            push.PUBLIC_KEY_COMMITMENT_SLOT[0..2] exec.native_account::get_initial_item
            exec.signature::authenticate_transaction
        end
      `;
      const codeBuilder = await client.createCodeBuilder();
      const authComponent = sdk.AccountComponent.fromLibrary(
        codeBuilder.buildLibrary("custom::auth::create_note", authCode),
        []
      ).withSupportsAllTypes();
      const lookalike = sdk.AccountComponent.fromLibrary(
        codeBuilder.buildLibrary("custom::lookalike", lookalikeCode),
        [
          sdk.StorageSlot.fromValue(
            "miden::standards::auth::singlesig::pub_key",
            new sdk.Word(sdk.u64Array([42, 0, 0, 0]))
          ),
        ]
      ).withSupportsAllTypes();

      const walletSeed = new Uint8Array(32);
      walletSeed.fill(0x2c);
      const wallet = new sdk.AccountBuilder(walletSeed)
        .withNoAuthComponent()
        .withBasicWalletComponent()
        .storageMode(sdk.AccountStorageMode.public())
        .build().account;
      const authIsCreateNote = wallet
        .code()
        .hasProcedure(
          sdk.Word.fromHex(authComponent.getProcedureHash("auth_create_note"))
        );
      const singleSigSeed = new Uint8Array(32);
      singleSigSeed.fill(0x2d);
      const singleSig = new sdk.AccountBuilder(singleSigSeed)
        .withAuthComponent(
          sdk.AccountComponent.createAuthComponentFromCommitment(
            new sdk.Word(sdk.u64Array([43, 0, 0, 0])),
            sdk.AuthScheme.AuthRpoFalcon512
          )
        )
        .withBasicWalletComponent()
        .storageMode(sdk.AccountStorageMode.public())
        .build().account;
      const lookalikeIsSingleSig = singleSig
        .code()
        .hasProcedure(sdk.Word.fromHex(lookalike.getProcedureHash("auth_tx")));

      let account = null;
      let buildError = null;
      try {
        const seed = new Uint8Array(32);
        seed.fill(0x2e);
        account = new sdk.AccountBuilder(seed)
          .withAuthComponent(authComponent)
          .withComponent(lookalike)
          .storageMode(sdk.AccountStorageMode.public())
          .build().account;
      } catch (err) {
        buildError = err?.message ?? String(err);
      }

      let keys = null;
      let error = null;
      if (account) {
        try {
          keys = account.getPublicKeyCommitments().length;
        } catch (err) {
          error = err?.message ?? String(err);
        }
      }

      return {
        authIsCreateNote,
        lookalikeIsSingleSig,
        buildError,
        keys,
        error,
      };
    });

    expect(result.authIsCreateNote).toBe(true);
    expect(result.lookalikeIsSingleSig).toBe(true);
    expect(result.buildError).toBeNull();
    expect(result.keys).toBeNull();
    expect(result.error).toContain(
      "not owned by exactly one standard auth component"
    );
  });

  test("throws when the auth procedure copies a multisig's non-auth export and the rest of the multisig sits elsewhere", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      // The @auth_script procedure has the root of the multisig's
      // get_threshold_and_num_approvers export, and an ordinary component exports every
      // other multisig procedure, its auth procedure included, so the account classifies
      // as a multisig whose auth procedure sits at a non-auth index.
      const authCode = `
        @auth_script
        pub proc auth_get_threshold
            exec.::miden::standards::auth::multisig::get_threshold_and_num_approvers
        end
      `;
      const restCode = `
        use miden::protocol::tx
        use miden::standards::auth::multisig
        use miden::standards::auth::signature
        use miden::standards::fee

        pub use {update_signers_and_threshold} from miden::standards::auth::multisig
        pub use {set_procedure_threshold} from miden::standards::auth::multisig
        pub use {get_signer_at} from miden::standards::auth::multisig
        pub use {is_signer} from miden::standards::auth::multisig

        @account_procedure
        pub proc auth_tx_multisig(auth_args: word)
            exec.multisig::resolve_auth_args
            dup.5 exec.tx::get_reference_block_number
            exec.multisig::assert_approval_not_expired movdn.10
            exec.multisig::get_initial_threshold_and_num_approvers drop
            exec.signature::estimate_multisig_authentication_cycles
            dup.5 movdn.5
            exec.fee::pay_fee drop
            exec.multisig::auth_tx
            exec.multisig::record_and_assert_new_tx
            exec.multisig::apply_approval_expiration
        end
      `;
      const codeBuilder = await client.createCodeBuilder();
      const authComponent = sdk.AccountComponent.fromLibrary(
        codeBuilder.buildLibrary("custom::auth::get_threshold", authCode),
        []
      ).withSupportsAllTypes();
      const approverKeys = new sdk.StorageMap();
      approverKeys.insert(
        new sdk.Word(sdk.u64Array([0, 0, 0, 0])),
        new sdk.Word(sdk.u64Array([44, 0, 0, 0]))
      );
      approverKeys.insert(
        new sdk.Word(sdk.u64Array([1, 0, 0, 0])),
        new sdk.Word(sdk.u64Array([45, 0, 0, 0]))
      );
      const rest = sdk.AccountComponent.compile(
        codeBuilder.compileAccountComponentCode(restCode),
        [
          sdk.StorageSlot.fromValue(
            "miden::standards::auth::multisig::threshold_config",
            new sdk.Word(sdk.u64Array([1, 2, 0, 0]))
          ),
          sdk.StorageSlot.map(
            "miden::standards::auth::multisig::approver_public_keys",
            approverKeys
          ),
        ]
      ).withSupportsAllTypes();

      const multisigSeed = new Uint8Array(32);
      multisigSeed.fill(0x2f);
      const multisig = new sdk.AccountBuilder(multisigSeed)
        .withAuthComponent(
          sdk.createAuthFalcon512RpoMultisig(
            new sdk.AuthFalcon512RpoMultisigConfig(
              [1, 2].map((n) => new sdk.Word(sdk.u64Array([n, 0, 0, 0]))),
              1
            )
          )
        )
        .withBasicWalletComponent()
        .storageMode(sdk.AccountStorageMode.public())
        .build().account;
      const authIsMultisigExport = multisig
        .code()
        .hasProcedure(
          sdk.Word.fromHex(authComponent.getProcedureHash("auth_get_threshold"))
        );
      const restHasMultisigAuth = multisig
        .code()
        .hasProcedure(
          sdk.Word.fromHex(rest.getProcedureHash("auth_tx_multisig"))
        );

      let account = null;
      let buildError = null;
      try {
        const seed = new Uint8Array(32);
        seed.fill(0x30);
        account = new sdk.AccountBuilder(seed)
          .withAuthComponent(authComponent)
          .withComponent(rest)
          .storageMode(sdk.AccountStorageMode.public())
          .build().account;
      } catch (err) {
        buildError = err?.message ?? String(err);
      }

      let keys = null;
      let error = null;
      if (account) {
        try {
          keys = account.getPublicKeyCommitments().length;
        } catch (err) {
          error = err?.message ?? String(err);
        }
      }

      return {
        authIsMultisigExport,
        restHasMultisigAuth,
        buildError,
        keys,
        error,
      };
    });

    expect(result.authIsMultisigExport).toBe(true);
    expect(result.restHasMultisigAuth).toBe(true);
    expect(result.buildError).toBeNull();
    expect(result.keys).toBeNull();
    expect(result.error).toContain(
      "not owned by exactly one standard auth component"
    );
  });
});

// GET_ACCOUNT_BY_KEY_COMMITMENT TESTS
// =======================================================================================================

test.describe("getAccountByKeyCommitment tests", () => {
  test("finds wallet by key commitment after creation", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const wallet = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const commitments = await client.keystore.getCommitments(wallet.id());

      const foundAccountId = await client.keystore.getAccountId(commitments[0]);
      const foundAccount = foundAccountId
        ? await client.getAccount(foundAccountId)
        : undefined;

      return {
        foundAccountDefined: foundAccount !== undefined,
        foundAccountId: foundAccount.id().toString(),
        walletId: wallet.id().toString(),
      };
    });
    expect(result.foundAccountDefined).toBe(true);
    expect(result.foundAccountId).toEqual(result.walletId);
  });

  test("returns undefined for non-existent key commitment", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const randomSecretKey = sdk.AuthSecretKey.rpoFalconWithRNG(null);
      const randomCommitment = randomSecretKey.publicKey().toCommitment();

      const foundAccountId =
        await client.keystore.getAccountId(randomCommitment);
      const foundAccount = foundAccountId
        ? await client.getAccount(foundAccountId)
        : undefined;

      return { isUndefined: foundAccount === undefined };
    });
    expect(result.isUndefined).toBe(true);
  });

  test("finds correct account among multiple accounts", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const wallet1 = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const wallet2 = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const commitments2 = await client.keystore.getCommitments(wallet2.id());

      const foundAccountId = await client.keystore.getAccountId(
        commitments2[0]
      );
      const foundAccount = foundAccountId
        ? await client.getAccount(foundAccountId)
        : undefined;

      return {
        foundAccountId: foundAccount.id().toString(),
        wallet1Id: wallet1.id().toString(),
        wallet2Id: wallet2.id().toString(),
      };
    });
    expect(result.foundAccountId).toEqual(result.wallet2Id);
    expect(result.foundAccountId).not.toEqual(result.wallet1Id);
  });

  test("finds account by additionally registered key", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const wallet = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const additionalSecretKey = sdk.AuthSecretKey.ecdsaWithRNG(null);
      await client.keystore.insert(wallet.id(), additionalSecretKey);

      const additionalCommitment = additionalSecretKey
        .publicKey()
        .toCommitment();
      const foundAccountId =
        await client.keystore.getAccountId(additionalCommitment);
      const foundAccount = foundAccountId
        ? await client.getAccount(foundAccountId)
        : undefined;

      return {
        foundAccountDefined: foundAccount !== undefined,
        foundAccountId: foundAccount.id().toString(),
        walletId: wallet.id().toString(),
      };
    });
    expect(result.foundAccountDefined).toBe(true);
    expect(result.foundAccountId).toEqual(result.walletId);
  });

  test("finds faucet by key commitment", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      const faucet = await client.newFaucet(
        sdk.AccountStorageMode.private(),
        false,
        "TST",
        "TST",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const commitments = await client.keystore.getCommitments(faucet.id());

      const foundAccountId = await client.keystore.getAccountId(commitments[0]);
      const foundAccount = foundAccountId
        ? await client.getAccount(foundAccountId)
        : undefined;

      return {
        foundAccountId: foundAccount.id().toString(),
        faucetId: faucet.id().toString(),
        isFaucet: foundAccount.isFaucet(),
      };
    });
    expect(result.foundAccountId).toEqual(result.faucetId);
    expect(result.isFaucet).toBe(true);
  });
});

// GET_ACCOUNT_PROOF VAULT COMMITMENT TESTS
// =======================================================================================================
// Skipped: requires a running node and browser-specific helpers (createNewWallet, fundAccountFromFaucet)
