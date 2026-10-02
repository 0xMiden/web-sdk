import { test, expect } from "./test-setup";

test.describe("non-fungible asset vault entries", () => {
  test("preserves the issuer, complete key, and all four value limbs", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const issuer = sdk.AccountId.fromHex("0x69817bcc6fb9f99127c2245f6979c5");
      const value = new sdk.Word(
        sdk.u64Array([11n, 22n, 9007199254740993n, 44n])
      );
      const key = new sdk.Word(
        sdk.u64Array([
          11n,
          22n,
          issuer.suffix().asInt(),
          issuer.prefix().asInt(),
        ])
      );
      const asset = sdk.VaultAsset.nonFungible({ key, value });
      const copy = sdk.VaultAsset.fromVaultEntry(
        asset.vaultKey(),
        asset.intoWord()
      );
      const differentValue = new sdk.Word(sdk.u64Array([11n, 22n, 55n, 66n]));
      const different = sdk.VaultAsset.nonFungible({
        key,
        value: differentValue,
      });
      return {
        issuer: copy.faucetId().toString(),
        expectedIssuer: issuer.toString(),
        key: copy.vaultKey().toHex(),
        expectedKey: key.toHex(),
        value: Array.from(copy.intoWord().toU64s(), String),
        sameKey: different.vaultKey().toHex() === asset.vaultKey().toHex(),
        differentValue:
          different.intoWord().toHex() !== asset.intoWord().toHex(),
        kind: copy.kind(),
        variantValue: copy.asNonFungible().intoWord().toHex(),
        originalValue: value.toHex(),
      };
    });
    expect(result.issuer).toBe(result.expectedIssuer);
    expect(result.key).toBe(result.expectedKey);
    expect(result.value).toEqual(["11", "22", "9007199254740993", "44"]);
    expect(result.sameKey).toBe(true);
    expect(result.differentValue).toBe(true);
    expect(result.kind).toBe("nonFungible");
    expect(result.variantValue).toBe(result.originalValue);
  });

  test("rejects invalid keys, fungible entries, and mismatched asset classes", async ({
    run,
  }) => {
    const errors = await run(async ({ sdk }) => {
      const issuer = sdk.AccountId.fromHex("0x69817bcc6fb9f99127c2245f6979c5");
      const fungible = new sdk.FungibleAsset(issuer, sdk.u64(10));
      const value = new sdk.Word(sdk.u64Array([11n, 22n, 33n, 44n]));
      const mismatchedKey = new sdk.Word(
        sdk.u64Array([
          12n,
          22n,
          issuer.suffix().asInt(),
          issuer.prefix().asInt(),
        ])
      );
      const entries = [
        [new sdk.Word(sdk.u64Array([0n, 0n, 0n, 0n])), value],
        [fungible.vaultKey(), fungible.intoWord()],
        [mismatchedKey, value],
      ];
      return entries.map(([key, entryValue]) => {
        try {
          sdk.NonFungibleAsset.fromVaultEntry(key, entryValue);
          return "accepted";
        } catch (error) {
          return String(error);
        }
      });
    });
    for (const error of errors) {
      expect(error).toContain("Failed to create NonFungibleAsset");
    }
  });

  test("enumerates a restored mixed vault without registration history", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const account = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const serialized = account.serialize();
      // Account bytes start with a 15-byte ID and a variable-length vault count.
      // An empty vault count is one byte (1). Three assets use one byte (7).
      const issuerBytes = serialized.slice(0, 15);
      const values = [
        new sdk.Word(sdk.u64Array([11n, 22n, 9007199254740993n, 44n])),
        new sdk.Word(sdk.u64Array([55n, 66n, 77n, 88n])),
      ];
      // Each asset starts with its composition byte and the 15-byte issuer ID.
      // A fungible asset then stores a u64; a non-fungible asset stores a Word.
      const amount = new Uint8Array(8);
      new DataView(amount.buffer).setBigUint64(0, 10n, true);
      const fungibleBytes = [1, ...issuerBytes, ...amount];
      const restored = sdk.Account.deserialize(
        new Uint8Array([
          ...issuerBytes,
          7,
          ...fungibleBytes,
          0,
          ...issuerBytes,
          ...values[0].serialize(),
          0,
          ...issuerBytes,
          ...values[1].serialize(),
          ...serialized.slice(16),
        ])
      );
      const fungibleOnly = sdk.Account.deserialize(
        new Uint8Array([
          ...issuerBytes,
          3,
          ...fungibleBytes,
          ...serialized.slice(16),
        ])
      );
      const vault = restored.vault();
      const actual = vault.nonFungibleAssets().map((asset) => ({
        issuer: asset.faucetId().toString(),
        key: asset.vaultKey().toHex(),
        value: Array.from(asset.intoWord().toU64s(), String),
      }));
      const expected = values.map((value) => {
        const limbs = value.toU64s();
        const key = new sdk.Word(
          sdk.u64Array([
            limbs[0],
            limbs[1],
            account.id().suffix().asInt(),
            account.id().prefix().asInt(),
          ])
        );
        return {
          issuer: account.id().toString(),
          key: key.toHex(),
          value: Array.from(limbs, String),
        };
      });
      return {
        emptyCount: serialized[15],
        actual,
        expected,
        fungibleCount: vault.fungibleAssets().length,
        balance: String(vault.getBalance(account.id())),
        fungibleOnlyCount: fungibleOnly.vault().nonFungibleAssets().length,
        allKinds: vault
          .assets()
          .map((asset) => asset.kind())
          .sort(),
      };
    });
    expect(result.emptyCount).toBe(1);
    expect(result.actual).toHaveLength(2);
    expect(result.actual).toEqual(expect.arrayContaining(result.expected));
    expect(result.fungibleCount).toBe(1);
    expect(result.balance).toBe("10");
    expect(result.fungibleOnlyCount).toBe(0);
    expect(result.allKinds).toEqual(["fungible", "nonFungible", "nonFungible"]);
  });

  test("returns no non-fungible assets for an empty wallet", async ({
    run,
  }) => {
    const count = await run(async ({ client, sdk }) => {
      const account = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      return account.vault().nonFungibleAssets().length;
    });
    expect(count).toBe(0);
  });
});

test.describe("unified note assets", () => {
  test("accepts new and existing asset classes without consuming the inputs", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const issuer = sdk.AccountId.fromHex("0x69817bcc6fb9f99127c2245f6979c5");
      const legacy = new sdk.FungibleAsset(issuer, sdk.u64(100));
      const token = sdk.VaultAsset.fungible(issuer, sdk.u64(100));
      const key = new sdk.Word(
        sdk.u64Array([
          11n,
          22n,
          issuer.suffix().asInt(),
          issuer.prefix().asInt(),
        ])
      );
      const value = new sdk.Word(sdk.u64Array([11n, 22n, 33n, 44n]));
      const name = sdk.VaultAsset.nonFungible({ key, value });
      const legacyOnly = new sdk.NoteAssets([legacy]);
      const legacyPushed = new sdk.NoteAssets();
      legacyPushed.push(legacy);
      const mixed = new sdk.NoteAssets([name, legacy]);
      const pushed = new sdk.NoteAssets([token]);
      pushed.push(name);
      const concrete = new sdk.NoteAssets([name.asNonFungible()]);
      const concretePushed = new sdk.NoteAssets();
      concretePushed.push(name.asNonFungible());
      return {
        legacyAmount: String(legacyOnly.fungibleAssets()[0].amount()),
        pushedLegacyAmount: String(legacyPushed.fungibleAssets()[0].amount()),
        legacyStillUsable: String(legacy.amount()),
        tokenAmount: String(token.asFungible().amount()),
        mixedKinds: mixed.assets().map((asset) => asset.kind()),
        pushedKinds: pushed.assets().map((asset) => asset.kind()),
        concreteValue: concrete.nonFungibleAssets()[0].intoWord().toHex(),
        concretePushedValue: concretePushed
          .nonFungibleAssets()[0]
          .intoWord()
          .toHex(),
        originalValue: value.toHex(),
        originalKey: key.toHex(),
        retainedKey: name.vaultKey().toHex(),
        empty: new sdk.NoteAssets().assets().length,
      };
    });
    expect(result.legacyAmount).toBe("100");
    expect(result.pushedLegacyAmount).toBe("100");
    expect(result.legacyStillUsable).toBe("100");
    expect(result.tokenAmount).toBe("100");
    expect(result.mixedKinds).toEqual(["nonFungible", "fungible"]);
    expect(result.pushedKinds).toEqual(["fungible", "nonFungible"]);
    expect(result.concreteValue).toBe(result.originalValue);
    expect(result.concretePushedValue).toBe(result.originalValue);
    expect(result.retainedKey).toBe(result.originalKey);
    expect(result.empty).toBe(0);
  });

  test("rejects duplicates and excess assets without changing the collection", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const issuer = sdk.AccountId.fromHex("0x69817bcc6fb9f99127c2245f6979c5");
      const createName = (index) => {
        const limb = BigInt(index + 1);
        const key = new sdk.Word(
          sdk.u64Array([
            limb,
            22n,
            issuer.suffix().asInt(),
            issuer.prefix().asInt(),
          ])
        );
        const value = new sdk.Word(sdk.u64Array([limb, 22n, 33n, 44n]));
        return sdk.VaultAsset.nonFungible({ key, value });
      };
      const names = Array.from({ length: 17 }, (_, index) => createName(index));
      const full = new sdk.NoteAssets(names.slice(0, 16));
      const token = sdk.VaultAsset.fungible(issuer, sdk.u64(10));
      const legacy = new sdk.FungibleAsset(issuer, sdk.u64(20));
      const one = new sdk.NoteAssets([names[0]]);
      const operations = {
        "duplicate in constructor": () =>
          new sdk.NoteAssets([names[0], names[0]]),
        "duplicate fungible in constructor": () =>
          new sdk.NoteAssets([token, legacy]),
        "17 assets in constructor": () => new sdk.NoteAssets(names),
        "duplicate push": () => one.push(names[0]),
        "push past 16": () => full.push(names[16]),
        "fungible as non-fungible": () => token.asNonFungible(),
        "non-fungible as fungible": () => names[0].asFungible(),
        "fungible entry as non-fungible": () =>
          sdk.VaultAsset.nonFungible({
            key: token.vaultKey(),
            value: token.intoWord(),
          }),
      };
      // The browser throws the Rust message as a string, Node as an Error. A WASM trap
      // throws a WebAssembly.RuntimeError, which must not count as a rejection.
      const rejected = Object.fromEntries(
        Object.entries(operations).map(([label, operation]) => {
          try {
            operation();
            return [label, "accepted"];
          } catch (error) {
            if (error instanceof WebAssembly.RuntimeError) {
              return [label, `trap: ${error.message}`];
            }
            return [
              label,
              error instanceof Error ? error.message : String(error),
            ];
          }
        })
      );
      return {
        rejected,
        oneCount: one.assets().length,
        fullCount: full.assets().length,
        retainedValue: names[0].intoWord().toHex(),
        storedValue: one.assets()[0].intoWord().toHex(),
      };
    });
    const prefixes = {
      "duplicate in constructor": "Failed to create NoteAssets",
      "duplicate fungible in constructor": "Failed to create NoteAssets",
      "17 assets in constructor": "Failed to create NoteAssets",
      "duplicate push": "Failed to add note asset",
      "push past 16": "Failed to add note asset",
      "fungible as non-fungible": "Asset is not non-fungible",
      "non-fungible as fungible": "Asset is not fungible",
      "fungible entry as non-fungible": "Failed to create non-fungible asset",
    };
    for (const [label, prefix] of Object.entries(prefixes)) {
      expect(result.rejected[label], label).toMatch(new RegExp(`^${prefix}`));
    }
    expect(result.oneCount).toBe(1);
    expect(result.fullCount).toBe(16);
    expect(result.storedValue).toBe(result.retainedValue);
  });

  test("debits an NFA into a network note and restores it from a returned P2ID", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const owner = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const networkAuth = sdk.AccountComponent.createNetworkAuthComponents(
        [new sdk.NoteScriptFee(sdk.NoteScript.p2id().root(), sdk.u64(0))],
        owner.id()
      );
      const registryBuilder = new sdk.AccountBuilder(new Uint8Array(32).fill(7))
        .storageMode(sdk.AccountStorageMode.public())
        .withBasicWalletComponent();
      for (const component of networkAuth) {
        registryBuilder.withComponent(component);
      }
      const registry = registryBuilder.build().account;
      await client.newAccount(registry, false);
      // Commit the public target so the mock node can load its account state.
      await client.submitNewTransaction(
        registry.id(),
        new sdk.TransactionRequestBuilder().build()
      );
      await client.proveBlock();
      await client.syncState();
      const issuer = owner.id();
      const key = new sdk.Word(
        sdk.u64Array([
          11n,
          22n,
          issuer.suffix().asInt(),
          issuer.prefix().asInt(),
        ])
      );
      const value = new sdk.Word(
        sdk.u64Array([11n, 22n, 9007199254740993n, 44n])
      );
      const name = sdk.VaultAsset.nonFungible({ key, value });
      // Fund the sender locally before the transfer, without a live name faucet.
      const funding = sdk.Note.createP2IDNote(
        registry.id(),
        owner.id(),
        new sdk.NoteAssets([name]),
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );
      const funded = await client.executeTransaction(
        owner.id(),
        new sdk.TransactionRequestBuilder()
          .withExplicitInputNote(sdk.InputNote.unauthenticated(funding))
          .build()
      );
      await client.applyTransaction(funded, 0);
      const before = (await client.getAccount(owner.id())).vault().assets();
      const beforeKey = before[0].vaultKey().toHex();
      const beforeValue = before[0].intoWord().toHex();
      const noteAssets = new sdk.NoteAssets([name]);
      const metadata = new sdk.NoteMetadata(
        owner.id(),
        sdk.NoteType.Public,
        sdk.NoteTag.withAccountTarget(registry.id())
      );
      const recipient = new sdk.NoteRecipient(
        new sdk.Word(sdk.u64Array([1n, 2n, 3n, 4n])),
        sdk.NoteScript.p2id(),
        new sdk.NoteStorage(
          new sdk.FeltArray([registry.id().suffix(), registry.id().prefix()])
        )
      );
      const publicNote = sdk.Note.withAttachments(
        noteAssets,
        metadata,
        recipient,
        [new sdk.NetworkAccountTarget(registry.id()).toAttachment()]
      );
      const ownOutputs = new sdk.NoteArray();
      ownOutputs.push(publicNote);
      const sent = await client.executeTransaction(
        owner.id(),
        new sdk.TransactionRequestBuilder()
          .withOwnOutputNotes(ownOutputs)
          .build()
      );
      const emitted = sent
        .executedTransaction()
        .outputNotes()
        .getNote(0)
        .intoFull();
      const restored = sdk.Note.deserialize(emitted.serialize());
      await client.applyTransaction(sent, 0);
      const afterSend = (await client.getAccount(owner.id())).vault().assets();
      const returned = sdk.Note.createP2IDNote(
        registry.id(),
        owner.id(),
        restored.assets(),
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );
      // Simulate the registry's P2ID response with the asset from the executed output.
      // Registry contract execution is outside this low-level binding test.
      const request = new sdk.TransactionRequestBuilder()
        .withExplicitInputNote(sdk.InputNote.unauthenticated(returned))
        .build();
      const consumed = await client.executeTransaction(owner.id(), request);
      await client.applyTransaction(consumed, 0);
      const updated = await client.getAccount(owner.id());
      const owned = updated.vault().assets();
      return {
        beforeCount: before.length,
        beforeKey,
        beforeValue,
        afterSendCount: afterSend.length,
        networkNote: restored.isNetworkNote(),
        target: sdk.NetworkAccountTarget.fromAttachment(
          restored.attachments()[0]
        )
          .targetId()
          .toString(),
        expectedTarget: registry.id().toString(),
        noteCount: restored.assets().assets().length,
        noteKey: restored.assets().assets()[0].vaultKey().toHex(),
        noteValue: restored.assets().assets()[0].intoWord().toHex(),
        vaultCount: owned.length,
        vaultKind: owned[0].kind(),
        vaultKey: owned[0].vaultKey().toHex(),
        vaultValue: owned[0].intoWord().toHex(),
        expectedKey: key.toHex(),
        expectedValue: value.toHex(),
      };
    });
    expect(result.beforeCount).toBe(1);
    expect(result.beforeKey).toBe(result.expectedKey);
    expect(result.beforeValue).toBe(result.expectedValue);
    expect(result.afterSendCount).toBe(0);
    expect(result.networkNote).toBe(true);
    expect(result.target).toBe(result.expectedTarget);
    expect(result.noteCount).toBe(1);
    expect(result.noteKey).toBe(result.expectedKey);
    expect(result.noteValue).toBe(result.expectedValue);
    expect(result.vaultCount).toBe(1);
    expect(result.vaultKind).toBe("nonFungible");
    expect(result.vaultKey).toBe(result.expectedKey);
    expect(result.vaultValue).toBe(result.expectedValue);
  });
});
