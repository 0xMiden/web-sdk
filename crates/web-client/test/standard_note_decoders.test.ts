// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("standard note decoders", () => {
  test("P2idNote.tryFromNote decodes the target and rejects other notes", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      // `run` serializes this callback into the browser page, so helpers live inside it.
      async function fixtures(client, sdk) {
        await client.syncState();
        const sender = await client.newWallet(
          sdk.AccountStorageMode.public(),
          sdk.AuthScheme.AuthRpoFalcon512
        );
        const target = await client.newWallet(
          sdk.AccountStorageMode.public(),
          sdk.AuthScheme.AuthRpoFalcon512
        );
        const newFaucet = (symbol) =>
          client.newFaucet(
            sdk.AccountStorageMode.public(),
            false,
            symbol,
            symbol,
            8,
            sdk.u64(1_000_000),
            sdk.AuthScheme.AuthRpoFalcon512
          );
        const faucetA = await newFaucet("AAA");
        const faucetB = await newFaucet("BBB");
        const assets = () =>
          new sdk.NoteAssets([new sdk.FungibleAsset(faucetA.id(), sdk.u64(7))]);
        return { sender, target, faucetA, faucetB, assets };
      }

      function errorOf(fn) {
        try {
          fn();
          return null;
        } catch (err) {
          return String(err?.message ?? err);
        }
      }

      const { sender, target, faucetA, assets } = await fixtures(client, sdk);
      const note = sdk.Note.createP2IDNote(
        sender.id(),
        target.id(),
        assets(),
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );
      const decoded = sdk.P2idNote.tryFromNote(note);
      const p2ide = sdk.Note.createP2IDENote(
        sender.id(),
        target.id(),
        assets(),
        10,
        undefined,
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );
      const malformed = new sdk.Note(
        assets(),
        new sdk.NoteMetadata(
          sender.id(),
          sdk.NoteType.Public,
          sdk.NoteTag.withAccountTarget(target.id())
        ),
        new sdk.NoteRecipient(
          new sdk.Word(sdk.u64Array([1, 2, 3, 4])),
          sdk.NoteScript.p2id(),
          new sdk.NoteStorage(new sdk.FeltArray([target.id().suffix()]))
        )
      );
      return {
        target: decoded.target().toString(),
        expectedTarget: target.id().toString(),
        sender: decoded.sender().toString(),
        expectedSender: sender.id().toString(),
        amount: Number(decoded.assets().fungibleAssets()[0].amount()),
        faucet: decoded.assets().fungibleAssets()[0].faucetId().toString(),
        expectedFaucet: faucetA.id().toString(),
        noteType: decoded.noteType(),
        expectedNoteType: sdk.NoteType.Public,
        serial: decoded.serialNumber().toHex(),
        expectedSerial: note.recipient().serialNum().toHex(),
        roundTripId: decoded.intoNote().id().toString(),
        originalId: note.id().toString(),
        wrongScriptError: errorOf(() => sdk.P2idNote.tryFromNote(p2ide)),
        malformedError: errorOf(() => sdk.P2idNote.tryFromNote(malformed)),
      };
    });

    expect(result.target).toBe(result.expectedTarget);
    expect(result.sender).toBe(result.expectedSender);
    expect(result.amount).toBe(7);
    expect(result.faucet).toBe(result.expectedFaucet);
    expect(result.noteType).toBe(result.expectedNoteType);
    expect(result.serial).toBe(result.expectedSerial);
    expect(result.roundTripId).toBe(result.originalId);
    expect(result.wrongScriptError).toMatch(/not a P2ID note/);
    expect(result.malformedError).toMatch(/decode P2ID note/);
  });

  test("P2ideNote.tryFromNote decodes reclaim and timelock heights", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      // `run` serializes this callback into the browser page, so helpers live inside it.
      async function fixtures(client, sdk) {
        await client.syncState();
        const sender = await client.newWallet(
          sdk.AccountStorageMode.public(),
          sdk.AuthScheme.AuthRpoFalcon512
        );
        const target = await client.newWallet(
          sdk.AccountStorageMode.public(),
          sdk.AuthScheme.AuthRpoFalcon512
        );
        const newFaucet = (symbol) =>
          client.newFaucet(
            sdk.AccountStorageMode.public(),
            false,
            symbol,
            symbol,
            8,
            sdk.u64(1_000_000),
            sdk.AuthScheme.AuthRpoFalcon512
          );
        const faucetA = await newFaucet("AAA");
        const faucetB = await newFaucet("BBB");
        const assets = () =>
          new sdk.NoteAssets([new sdk.FungibleAsset(faucetA.id(), sdk.u64(7))]);
        return { sender, target, faucetA, faucetB, assets };
      }

      function errorOf(fn) {
        try {
          fn();
          return null;
        } catch (err) {
          return String(err?.message ?? err);
        }
      }

      const { sender, target, assets } = await fixtures(client, sdk);
      const reclaimable = sdk.Note.createP2IDENote(
        sender.id(),
        target.id(),
        assets(),
        42,
        undefined,
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );
      const timelocked = sdk.Note.createP2IDENote(
        sender.id(),
        target.id(),
        assets(),
        undefined,
        99,
        sdk.NoteType.Private,
        new sdk.NoteAttachment()
      );
      const p2id = sdk.Note.createP2IDNote(
        sender.id(),
        target.id(),
        assets(),
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );
      const a = sdk.P2ideNote.tryFromNote(reclaimable);
      const b = sdk.P2ideNote.tryFromNote(timelocked);
      return {
        target: a.target().toString(),
        expectedTarget: target.id().toString(),
        reclaimer: a.reclaimer().toString(),
        sender: a.sender().toString(),
        expectedSender: sender.id().toString(),
        reclaimHeight: a.reclaimHeight(),
        timelockUnset: a.timelockHeight() === undefined,
        reclaimUnset: b.reclaimHeight() === undefined,
        timelockHeight: b.timelockHeight(),
        noteType: b.noteType(),
        expectedNoteType: sdk.NoteType.Private,
        amount: Number(a.assets().fungibleAssets()[0].amount()),
        serial: a.serialNumber().toHex(),
        expectedSerial: reclaimable.recipient().serialNum().toHex(),
        roundTripId: b.intoNote().id().toString(),
        originalId: timelocked.id().toString(),
        wrongScriptError: errorOf(() => sdk.P2ideNote.tryFromNote(p2id)),
      };
    });

    expect(result.target).toBe(result.expectedTarget);
    expect(result.reclaimer).toBe(result.expectedSender);
    expect(result.sender).toBe(result.expectedSender);
    expect(result.reclaimHeight).toBe(42);
    expect(result.timelockUnset).toBe(true);
    expect(result.reclaimUnset).toBe(true);
    expect(result.timelockHeight).toBe(99);
    expect(result.noteType).toBe(result.expectedNoteType);
    expect(result.amount).toBe(7);
    expect(result.serial).toBe(result.expectedSerial);
    expect(result.roundTripId).toBe(result.originalId);
    expect(result.wrongScriptError).toMatch(/not a P2IDE note/);
  });

  test("SwapNote.tryFromNote decodes both sides of the swap and its payback", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      // `run` serializes this callback into the browser page, so helpers live inside it.
      async function fixtures(client, sdk) {
        await client.syncState();
        const sender = await client.newWallet(
          sdk.AccountStorageMode.public(),
          sdk.AuthScheme.AuthRpoFalcon512
        );
        const target = await client.newWallet(
          sdk.AccountStorageMode.public(),
          sdk.AuthScheme.AuthRpoFalcon512
        );
        const newFaucet = (symbol) =>
          client.newFaucet(
            sdk.AccountStorageMode.public(),
            false,
            symbol,
            symbol,
            8,
            sdk.u64(1_000_000),
            sdk.AuthScheme.AuthRpoFalcon512
          );
        const faucetA = await newFaucet("AAA");
        const faucetB = await newFaucet("BBB");
        const assets = () =>
          new sdk.NoteAssets([new sdk.FungibleAsset(faucetA.id(), sdk.u64(7))]);
        return { sender, target, faucetA, faucetB, assets };
      }

      function errorOf(fn) {
        try {
          fn();
          return null;
        } catch (err) {
          return String(err?.message ?? err);
        }
      }

      const { sender, target, faucetA, faucetB, assets } = await fixtures(
        client,
        sdk
      );
      const swapNote = async (paybackType) =>
        (
          await client.newSwapTransactionRequest(
            sender.id(),
            faucetA.id(),
            sdk.u64(10),
            faucetB.id(),
            sdk.u64(5),
            sdk.NoteType.Public,
            paybackType
          )
        ).expectedOutputOwnNotes()[0];
      const publicNote = await swapNote(sdk.NoteType.Public);
      const privateNote = await swapNote(sdk.NoteType.Private);
      const pub = sdk.SwapNote.tryFromNote(publicNote);
      const priv = sdk.SwapNote.tryFromNote(privateNote);
      const p2id = sdk.Note.createP2IDNote(
        sender.id(),
        target.id(),
        assets(),
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );
      // Same SWAP script and storage, but not exactly one asset.
      const offered = new sdk.FungibleAsset(faucetA.id(), sdk.u64(10));
      const requested = new sdk.FungibleAsset(faucetB.id(), sdk.u64(5));
      const withAssets = (list) =>
        new sdk.Note(
          new sdk.NoteAssets(list),
          publicNote.metadata(),
          publicNote.recipient()
        );
      return {
        sender: pub.sender().toString(),
        expectedSender: sender.id().toString(),
        offeredFaucet: pub.offeredAsset().faucetId().toString(),
        offeredAmount: Number(pub.offeredAsset().asFungible().amount()),
        expectedOfferedFaucet: faucetA.id().toString(),
        requestedFaucet: pub.requestedAsset().faucetId().toString(),
        requestedAmount: Number(pub.requestedAsset().asFungible().amount()),
        expectedRequestedFaucet: faucetB.id().toString(),
        paybackTag: pub.paybackTag().asU32(),
        expectedPaybackTag: sdk.NoteTag.withAccountTarget(sender.id()).asU32(),
        publicPaybackType: pub.paybackNoteType(),
        privatePaybackType: priv.paybackNoteType(),
        expectedPublic: sdk.NoteType.Public,
        expectedPrivate: sdk.NoteType.Private,
        publicPaybackTarget: pub.paybackTarget()?.toString(),
        publicRecipientUnset: pub.paybackRecipient() === undefined,
        privateTargetUnset: priv.paybackTarget() === undefined,
        privateRecipientHex: priv.paybackRecipient()?.toHex(),
        noteType: pub.noteType(),
        serial: pub.serialNumber().toHex(),
        expectedSerial: publicNote.recipient().serialNum().toHex(),
        roundTripId: priv.intoNote().id().toString(),
        originalId: privateNote.id().toString(),
        wrongScriptError: errorOf(() => sdk.SwapNote.tryFromNote(p2id)),
        twoAssetsError: errorOf(() =>
          sdk.SwapNote.tryFromNote(withAssets([offered, requested]))
        ),
        noAssetsError: errorOf(() => sdk.SwapNote.tryFromNote(withAssets([]))),
      };
    });

    expect(result.sender).toBe(result.expectedSender);
    expect(result.offeredFaucet).toBe(result.expectedOfferedFaucet);
    expect(result.offeredAmount).toBe(10);
    expect(result.requestedFaucet).toBe(result.expectedRequestedFaucet);
    expect(result.requestedAmount).toBe(5);
    expect(result.paybackTag).toBe(result.expectedPaybackTag);
    expect(result.publicPaybackType).toBe(result.expectedPublic);
    expect(result.privatePaybackType).toBe(result.expectedPrivate);
    expect(result.publicPaybackTarget).toBe(result.expectedSender);
    expect(result.publicRecipientUnset).toBe(true);
    expect(result.privateTargetUnset).toBe(true);
    expect(result.privateRecipientHex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.noteType).toBe(result.expectedPublic);
    expect(result.serial).toBe(result.expectedSerial);
    expect(result.roundTripId).toBe(result.originalId);
    expect(result.wrongScriptError).toMatch(/not a SWAP note/);
    expect(result.twoAssetsError).toMatch(/exactly one offered asset/);
    expect(result.noAssetsError).toMatch(/exactly one offered asset/);
  });

  test("BurnNote.tryFromNote decodes the asset and rejects other notes", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      function errorOf(fn) {
        try {
          fn();
          return null;
        } catch (err) {
          return String(err?.message ?? err);
        }
      }

      await client.syncState();
      const sender = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const faucet = await client.newFaucet(
        sdk.AccountStorageMode.public(),
        false,
        "BRN",
        "BRN",
        8,
        sdk.u64(1_000_000),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const vaultAsset = sdk.VaultAsset.fungible(faucet.id(), sdk.u64(9));
      const storageFelts = [
        ...vaultAsset.vaultKey().toFelts(),
        ...vaultAsset.intoWord().toFelts(),
      ];
      const burn = new sdk.Note(
        new sdk.NoteAssets([new sdk.FungibleAsset(faucet.id(), sdk.u64(9))]),
        new sdk.NoteMetadata(
          sender.id(),
          sdk.NoteType.Public,
          sdk.NoteTag.withAccountTarget(faucet.id())
        ),
        new sdk.NoteRecipient(
          new sdk.Word(sdk.u64Array([1, 2, 3, 4])),
          sdk.NoteScript.burn(),
          new sdk.NoteStorage(new sdk.FeltArray(storageFelts))
        )
      );
      const p2id = sdk.Note.createP2IDNote(
        sender.id(),
        sender.id(),
        new sdk.NoteAssets([new sdk.FungibleAsset(faucet.id(), sdk.u64(1))]),
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );
      const decoded = sdk.BurnNote.tryFromNote(burn);
      return {
        faucet: decoded.faucetId().toString(),
        expectedFaucet: faucet.id().toString(),
        amount: Number(
          decoded.asset().kind() === "fungible"
            ? decoded.asset().intoWord().toU64s()[0]
            : -1
        ),
        sender: decoded.sender().toString(),
        expectedSender: sender.id().toString(),
        roundTripId: decoded.intoNote().id().toString(),
        originalId: burn.id().toString(),
        wrongScriptError: errorOf(() => sdk.BurnNote.tryFromNote(p2id)),
        mintWrongScript: errorOf(() => sdk.MintNote.tryFromNote(p2id)),
        pswapWrongScript: errorOf(() => sdk.PswapNote.tryFromNote(p2id)),
      };
    });

    expect(result.faucet).toBe(result.expectedFaucet);
    expect(result.sender).toBe(result.expectedSender);
    expect(result.roundTripId).toBe(result.originalId);
    expect(result.wrongScriptError).toMatch(/not a BURN note/);
    expect(result.mintWrongScript).toMatch(/not a MINT note/);
    expect(result.pswapWrongScript).toMatch(/PSWAP|pswap|decode PSWAP/i);
  });
});
