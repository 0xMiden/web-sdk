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
    expect(result.assetAmount).toBe(10);
    expect(result.assetFaucet).toBe(result.expectedFaucet);
    expect(result.noteType).toBe(result.expectedPublic);
    expect(result.roundTripId).toBe(result.originalId);
  });

  test("createFeeSponsorshipNote rejects a private target", async ({ run }) => {
    const result = await run(async ({ client, sdk }) => {
      await client.syncState();

      const sender = await client.newWallet(
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
        privateTarget.id(),
        new sdk.NoteAssets([new sdk.FungibleAsset(faucet.id(), sdk.u64(1))]),
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );

      let message = null;
      try {
        sdk.Note.createFeeSponsorshipNote(
          sender.id(),
          privateTarget.id(),
          featureNote.id(),
          new sdk.FungibleAsset(faucet.id(), sdk.u64(10)),
          undefined,
          undefined
        );
      } catch (err) {
        message = String(err?.message ?? err);
      }
      return { message };
    });

    expect(result.message).toMatch(/must be public/i);
  });
});
