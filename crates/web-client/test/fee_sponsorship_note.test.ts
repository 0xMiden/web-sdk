// @ts-nocheck
import { test, expect } from "./test-setup";

// Mirrors the upstream FeeSponsorshipNote builder fixture shape: bind a feature
// note id, tag a public target, optional reclaimer / reclaim height, then
// round-trip decode through FeeSponsorshipNote.tryFromNote.

test.describe("FeeSponsorshipNote", () => {
  test("createFeeSponsorshipNote binds feature note and round-trips decode", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      await client.syncState();

      const sender = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const target = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const faucet = await client.newFaucet(
        sdk.AccountStorageMode.public(),
        false,
        "FEE",
        "FEE",
        8,
        sdk.u64(1_000_000),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const featureNote = sdk.Note.createP2IDNote(
        sender.id(),
        target.id(),
        new sdk.NoteAssets([new sdk.FungibleAsset(faucet.id(), sdk.u64(1))]),
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );

      const feeAsset = new sdk.FungibleAsset(faucet.id(), sdk.u64(10));
      const reclaimHeight = 42;
      const sponsorship = sdk.Note.createFeeSponsorshipNote(
        sender.id(),
        target.id(),
        featureNote.id(),
        feeAsset,
        undefined,
        reclaimHeight
      );

      const decoded = sdk.FeeSponsorshipNote.tryFromNote(sponsorship);
      const scriptRoot = sponsorship.script().root().toHex();
      const expectedScriptRoot = sdk.NoteScript.feeSponsorship().root().toHex();

      return {
        scriptRoot,
        expectedScriptRoot,
        featureNoteId: decoded.featureNoteId().toString(),
        expectedFeatureNoteId: featureNote.id().toString(),
        sender: decoded.sender().toString(),
        expectedSender: sender.id().toString(),
        reclaimer: decoded.reclaimer().toString(),
        reclaimHeight: decoded.reclaimHeight(),
        tag: decoded.tag().asU32(),
        expectedTag: sdk.NoteTag.withAccountTarget(target.id()).asU32(),
        decodedSerialHex: decoded.serialNumber().toHex(),
        noteSerialHex: sponsorship.recipient().serialNum().toHex(),
        attachmentCount: sponsorship.attachments().length,
        assetAmount: Number(decoded.asset().amount()),
        assetFaucet: decoded.asset().faucetId().toString(),
        expectedFaucet: faucet.id().toString(),
        noteType: sponsorship.metadata().noteType(),
        expectedPublic: sdk.NoteType.Public,
        roundTripId: decoded.intoNote().id().toString(),
        originalId: sponsorship.id().toString(),
      };
    });

    expect(result.scriptRoot).toBe(result.expectedScriptRoot);
    expect(result.featureNoteId).toBe(result.expectedFeatureNoteId);
    expect(result.sender).toBe(result.expectedSender);
    expect(result.reclaimer).toBe(result.expectedSender);
    expect(result.reclaimHeight).toBe(42);
    expect(result.tag).toBe(result.expectedTag);
    expect(result.decodedSerialHex).toBe(result.noteSerialHex);
    expect(result.attachmentCount).toBe(0);
    expect(result.assetAmount).toBe(10);
    expect(result.assetFaucet).toBe(result.expectedFaucet);
    expect(result.noteType).toBe(result.expectedPublic);
    expect(result.roundTripId).toBe(result.originalId);
  });

  test("standalone createFeeSponsorshipNote supports AccountRef variants, preserves reclaimer handle, and leaves omitted reclaimHeight undefined", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      await client.syncState();

      const sender = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const target = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const reclaimerAccount = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const privateTarget = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const faucet = await client.newFaucet(
        sdk.AccountStorageMode.public(),
        false,
        "FEE",
        "FEE",
        8,
        sdk.u64(1_000_000),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const featureNote = sdk.Note.createP2IDNote(
        sender.id(),
        target.id(),
        new sdk.NoteAssets([new sdk.FungibleAsset(faucet.id(), sdk.u64(1))]),
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );

      const reclaimerId = reclaimerAccount.id();
      const targetBech32 = target
        .id()
        .toBech32(sdk.NetworkId.testnet(), sdk.AccountInterface.BasicWallet);

      // Account + bech32 string + explicit AccountId reclaimer, omitted reclaimAfter.
      const sponsorship = sdk.createFeeSponsorshipNote({
        from: sender,
        to: targetBech32,
        featureNoteId: featureNote.id(),
        asset: new sdk.FungibleAsset(faucet.id(), sdk.u64(10)),
        reclaimer: reclaimerId,
      });
      const reclaimerAfterSuccess = reclaimerId.toString();

      // Hex string + AccountId + omitted reclaimer/reclaimAfter.
      const defaulted = sdk.createFeeSponsorshipNote({
        from: sender.id().toString(),
        to: target.id(),
        featureNoteId: featureNote.id(),
        asset: new sdk.FungibleAsset(faucet.id(), sdk.u64(15)),
      });

      const decoded = sdk.FeeSponsorshipNote.tryFromNote(sponsorship);
      const decodedDefaulted = sdk.FeeSponsorshipNote.tryFromNote(defaulted);

      // Error path must also leave the caller's reclaimer AccountId handle intact.
      let privateError = null;
      try {
        sdk.createFeeSponsorshipNote({
          from: sender,
          to: privateTarget.id(),
          featureNoteId: featureNote.id(),
          asset: new sdk.FungibleAsset(faucet.id(), sdk.u64(10)),
          reclaimer: reclaimerId,
        });
      } catch (err) {
        privateError = String(err?.message ?? err);
      }
      const reclaimerAfterError = reclaimerId.toString();

      return {
        decodedSender: decoded.sender().toString(),
        expectedSender: sender.id().toString(),
        decodedReclaimer: decoded.reclaimer().toString(),
        expectedReclaimer: reclaimerAccount.id().toString(),
        reclaimerAfterSuccess,
        reclaimerAfterError,
        isUndefinedExplicit: decoded.reclaimHeight() === undefined,
        isDefaultedReclaimUndefined:
          decodedDefaulted.reclaimHeight() === undefined,
        defaultedReclaimer: decodedDefaulted.reclaimer().toString(),
        privateError,
      };
    });

    expect(result.decodedSender).toBe(result.expectedSender);
    expect(result.decodedReclaimer).toBe(result.expectedReclaimer);
    expect(result.reclaimerAfterSuccess).toBe(result.expectedReclaimer);
    expect(result.reclaimerAfterError).toBe(result.expectedReclaimer);
    expect(result.isUndefinedExplicit).toBe(true);
    expect(result.isDefaultedReclaimUndefined).toBe(true);
    expect(result.defaultedReclaimer).toBe(result.expectedSender);
    expect(result.privateError).toMatch(/must be public/i);
  });

  test("rejects reclaim_height = 0, invalid standalone reclaimAfter numbers, private target, and non-sponsorship notes", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      await client.syncState();

      const sender = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const target = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const privateTarget = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const faucet = await client.newFaucet(
        sdk.AccountStorageMode.public(),
        false,
        "FEE",
        "FEE",
        8,
        sdk.u64(1_000_000),
        sdk.AuthScheme.AuthRpoFalcon512
      );

      const featureNote = sdk.Note.createP2IDNote(
        sender.id(),
        target.id(),
        new sdk.NoteAssets([new sdk.FungibleAsset(faucet.id(), sdk.u64(1))]),
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );

      const captureError = (fn) => {
        try {
          fn();
          return null;
        } catch (err) {
          return String(err?.message ?? err);
        }
      };

      const staticZeroErr = captureError(() =>
        sdk.Note.createFeeSponsorshipNote(
          sender.id(),
          target.id(),
          featureNote.id(),
          new sdk.FungibleAsset(faucet.id(), sdk.u64(10)),
          undefined,
          0
        )
      );

      const invalidStandaloneErrors = [
        0,
        -1,
        1.5,
        NaN,
        Infinity,
        0x1_0000_0000,
      ].map((reclaimAfter) =>
        captureError(() =>
          sdk.createFeeSponsorshipNote({
            from: sender,
            to: target,
            featureNoteId: featureNote.id(),
            asset: new sdk.FungibleAsset(faucet.id(), sdk.u64(10)),
            reclaimAfter,
          })
        )
      );

      const privateTargetErr = captureError(() =>
        sdk.Note.createFeeSponsorshipNote(
          sender.id(),
          privateTarget.id(),
          featureNote.id(),
          new sdk.FungibleAsset(faucet.id(), sdk.u64(10)),
          undefined,
          undefined
        )
      );

      const nonSponsorshipErr = captureError(() =>
        sdk.FeeSponsorshipNote.tryFromNote(featureNote)
      );

      return {
        staticZeroErr,
        invalidStandaloneErrors,
        privateTargetErr,
        nonSponsorshipErr,
      };
    });

    expect(result.staticZeroErr).toMatch(
      /reclaim_height must be greater than 0/i
    );
    for (const err of result.invalidStandaloneErrors) {
      expect(err).toMatch(/positive 32-bit integer/i);
    }
    expect(result.privateTargetErr).toMatch(/must be public/i);
    expect(result.nonSponsorshipErr).toMatch(/decode fee sponsorship note/i);
  });
});
