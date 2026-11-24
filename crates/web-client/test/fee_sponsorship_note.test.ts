// @ts-nocheck
import { test, expect } from "./test-setup";

// FEE SPONSORSHIP NOTE
// =======================================================================================================
//
// `Note.createFeeSponsorshipNote` builds the upstream `FeeSponsorshipNote`. The expected
// storage layout, tag and recipient digest are rebuilt here from public pieces, so both the
// browser and Node builds are checked against the upstream encoding rather than themselves.

const setup = async ({ sdk, helpers }) => {
  const mockClient = await helpers.createFreshMockClient();
  const sender = await mockClient.newWallet(
    sdk.AccountStorageMode.private(),
    sdk.AuthScheme.AuthRpoFalcon512,
    new Uint8Array(32).fill(1)
  );
  const reclaimer = await mockClient.newWallet(
    sdk.AccountStorageMode.private(),
    sdk.AuthScheme.AuthRpoFalcon512,
    new Uint8Array(32).fill(2)
  );
  const target = await mockClient.newWallet(
    sdk.AccountStorageMode.public(),
    sdk.AuthScheme.AuthRpoFalcon512,
    new Uint8Array(32).fill(3)
  );
  const faucet = await mockClient.newFaucet(
    sdk.AccountStorageMode.private(),
    false,
    "DAG",
    "DAG",
    8,
    sdk.u64(10000000),
    sdk.AuthScheme.AuthRpoFalcon512
  );
  const featureNote = sdk.Note.createP2IDNote(
    sender.id(),
    target.id(),
    new sdk.NoteAssets([new sdk.FungibleAsset(faucet.id(), sdk.u64(5))]),
    sdk.NoteType.Public,
    new sdk.NoteAttachment()
  );
  return { sender, reclaimer, target, faucet, featureNote };
};

test.describe("createFeeSponsorshipNote", () => {
  test("encodes target tag, reclaimer and reclaim height like upstream", async ({
    run,
  }) => {
    const result = await run(async ({ sdk, helpers }) => {
      const { sender, reclaimer, target, faucet, featureNote } = await setup({
        sdk,
        helpers,
      });
      const asset = new sdk.FungibleAsset(faucet.id(), sdk.u64(7));
      const note = sdk.Note.createFeeSponsorshipNote(
        sender.id(),
        target.id(),
        featureNote.id(),
        asset,
        reclaimer.id(),
        100
      );

      const idWord = sdk.Word.fromHex(featureNote.id().toString());
      const expectedItems = [
        ...idWord.toU64s().map((v) => BigInt(v)),
        BigInt(reclaimer.id().suffix().asInt()),
        BigInt(reclaimer.id().prefix().asInt()),
        100n,
      ].map((v) => v.toString());
      const items = note
        .recipient()
        .storage()
        .items()
        .map((f) => f.asInt().toString());

      const rebuilt = new sdk.NoteRecipient(
        note.recipient().serialNum(),
        sdk.NoteScript.feeSponsorship(),
        new sdk.NoteStorage(
          new sdk.FeltArray(
            expectedItems.map((v) => new sdk.Felt(sdk.u64(BigInt(v))))
          )
        )
      );

      return {
        items,
        expectedItems,
        digest: note.recipient().digest().toHex(),
        rebuiltDigest: rebuilt.digest().toHex(),
        scriptRoot: note.script().root().toHex(),
        expectedRoot: sdk.NoteScript.feeSponsorship().root().toHex(),
        tag: note.metadata().tag().asU32(),
        expectedTag: sdk.NoteTag.withAccountTarget(target.id()).asU32(),
        noteType: note.metadata().noteType(),
        publicType: sdk.NoteType.Public,
        sender: note.metadata().sender().toString(),
        expectedSender: sender.id().toString(),
        amount: note.assets().fungibleAssets()[0].amount().toString(),
      };
    });

    expect(result.items).toEqual(result.expectedItems);
    expect(result.digest).toBe(result.rebuiltDigest);
    expect(result.scriptRoot).toBe(result.expectedRoot);
    expect(result.tag).toBe(result.expectedTag);
    expect(result.noteType).toBe(result.publicType);
    expect(result.sender).toBe(result.expectedSender);
    expect(result.amount).toBe("7");
  });

  test("omitting the reclaim height disables reclaim", async ({ run }) => {
    const result = await run(async ({ sdk, helpers }) => {
      const { sender, reclaimer, target, faucet, featureNote } = await setup({
        sdk,
        helpers,
      });
      const note = sdk.Note.createFeeSponsorshipNote(
        sender.id(),
        target.id(),
        featureNote.id(),
        new sdk.FungibleAsset(faucet.id(), sdk.u64(7)),
        reclaimer.id()
      );
      return note
        .recipient()
        .storage()
        .items()
        .map((f) => f.asInt().toString());
    });
    expect(result).toHaveLength(7);
    expect(result[6]).toBe("0");
  });

  test("rejects a private target account", async ({ run }) => {
    const message = await run(async ({ sdk, helpers }) => {
      const { sender, reclaimer, faucet, featureNote } = await setup({
        sdk,
        helpers,
      });
      try {
        sdk.Note.createFeeSponsorshipNote(
          sender.id(),
          reclaimer.id(),
          featureNote.id(),
          new sdk.FungibleAsset(faucet.id(), sdk.u64(7)),
          reclaimer.id()
        );
        return "no error";
      } catch (e) {
        return String(e?.message ?? e);
      }
    });
    expect(message).toContain("must be public");
  });
});
