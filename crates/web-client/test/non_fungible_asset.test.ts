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
      const asset = sdk.Asset.nonFungible({ key, value });
      const copy = sdk.Asset.fromVaultEntry(asset.vaultKey(), asset.intoWord());
      const differentValue = new sdk.Word(sdk.u64Array([11n, 22n, 55n, 66n]));
      const different = sdk.Asset.nonFungible({ key, value: differentValue });
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
      const token = sdk.Asset.fungible(issuer, sdk.u64(100));
      const key = new sdk.Word(
        sdk.u64Array([
          11n,
          22n,
          issuer.suffix().asInt(),
          issuer.prefix().asInt(),
        ])
      );
      const value = new sdk.Word(sdk.u64Array([11n, 22n, 33n, 44n]));
      const name = sdk.Asset.nonFungible({ key, value });
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
        return sdk.Asset.nonFungible({ key, value });
      };
      const names = Array.from({ length: 17 }, (_, index) => createName(index));
      const full = new sdk.NoteAssets(names.slice(0, 16));
      const token = sdk.Asset.fungible(issuer, sdk.u64(10));
      const legacy = new sdk.FungibleAsset(issuer, sdk.u64(20));
      const one = new sdk.NoteAssets([names[0]]);
      const operations = [
        () => new sdk.NoteAssets([names[0], names[0]]),
        () => new sdk.NoteAssets([token, legacy]),
        () => new sdk.NoteAssets(names),
        () => one.push(names[0]),
        () => full.push(names[16]),
        () => token.asNonFungible(),
        () => names[0].asFungible(),
        () =>
          sdk.Asset.nonFungible({
            key: token.vaultKey(),
            value: token.intoWord(),
          }),
      ];
      const rejected = operations.map((operation) => {
        try {
          operation();
          return false;
        } catch {
          return true;
        }
      });
      return {
        rejected,
        oneCount: one.assets().length,
        fullCount: full.assets().length,
        retainedValue: names[0].intoWord().toHex(),
        storedValue: one.assets()[0].intoWord().toHex(),
      };
    });
    expect(result.rejected).toEqual(Array(8).fill(true));
    expect(result.oneCount).toBe(1);
    expect(result.fullCount).toBe(16);
    expect(result.storedValue).toBe(result.retainedValue);
  });

  test("carries a single NFA through public note serialization and a P2ID consume", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const owner = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const registry = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
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
      const name = sdk.Asset.nonFungible({ key, value });
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
      const publicNote = new sdk.Note(noteAssets, metadata, recipient);
      const restored = sdk.Note.deserialize(publicNote.serialize());
      const returned = sdk.Note.createP2IDNote(
        registry.id(),
        owner.id(),
        restored.assets(),
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );
      // Execute an explicit input locally to test NFA consumption without a live registry.
      const request = new sdk.TransactionRequestBuilder()
        .withExplicitInputNote(sdk.InputNote.unauthenticated(returned))
        .build();
      const consumed = await client.executeTransaction(owner.id(), request);
      await client.applyTransaction(consumed, 0);
      const updated = await client.getAccount(owner.id());
      const owned = updated.vault().assets();
      return {
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
    expect(result.noteCount).toBe(1);
    expect(result.noteKey).toBe(result.expectedKey);
    expect(result.noteValue).toBe(result.expectedValue);
    expect(result.vaultCount).toBe(1);
    expect(result.vaultKind).toBe("nonFungible");
    expect(result.vaultKey).toBe(result.expectedKey);
    expect(result.vaultValue).toBe(result.expectedValue);
  });
});
