// @ts-nocheck
import { test, expect } from "./test-setup";

// NOTE DETAILS COMMITMENT
// =======================================================================================================
//
// `Note.detailsCommitment()` (and the matching methods on OutputNote,
// NoteDetails, InputNoteRecord) must return the recipient+assets commitment
// wallets need for B2AGG exit hashing — not the note ID, which also commits
// metadata. See issue #454.

test.describe("note detailsCommitment", () => {
  test("Note, OutputNote, NoteDetails and InputNoteRecord agree and differ from the note id", async ({
    run,
  }) => {
    const result = await run(async ({ sdk, helpers }) => {
      const mockClient = await helpers.createFreshMockClient();

      const sender = await mockClient.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512,
        new Uint8Array(32).fill(1)
      );
      const target = await mockClient.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512,
        new Uint8Array(32).fill(2)
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

      const noteAssets = new sdk.NoteAssets([
        new sdk.FungibleAsset(faucet.id(), sdk.u64(42)),
      ]);
      const note = sdk.Note.createP2IDNote(
        sender.id(),
        target.id(),
        noteAssets,
        sdk.NoteType.Private,
        new sdk.NoteAttachment()
      );

      const noteDetailsHex = note.detailsCommitment().toHex();
      const noteIdHex = note.id().toString();
      const noteCommitmentHex = note.commitment().toHex();

      const outputFull = sdk.OutputNote.full(note);
      const outputFullHex = outputFull.detailsCommitment().toHex();

      const details = new sdk.NoteDetails(note.assets(), note.recipient());
      const detailsHex = details.detailsCommitment().toHex();

      // The value must depend on both assets and recipient (not just one of them).
      const recipientDigestHex = note.recipient().digest().toHex();
      const otherAssets = new sdk.NoteAssets([
        new sdk.FungibleAsset(faucet.id(), sdk.u64(43)),
      ]);
      const otherAmountHex = new sdk.NoteDetails(otherAssets, note.recipient())
        .detailsCommitment()
        .toHex();
      const sameDetailsHex = new sdk.NoteDetails(
        note.assets(),
        note.recipient()
      )
        .detailsCommitment()
        .toHex();

      // Store via mock transport so we can read InputNoteRecord.detailsCommitment.
      // Prefer getInputNotes: getInputNote(id) can miss an uncommitted private note
      // on the napi path even after fetchPrivateNotes.
      const recipientAddress = sdk.Address.fromAccountId(
        target.id(),
        "BasicWallet"
      );
      const proof = sdk.NoteInclusionProof.mockAtBlock(0);
      await mockClient.sendPrivateNote(note, recipientAddress, proof);
      await mockClient.fetchPrivateNotes();
      const stored = await mockClient.getInputNotes(
        new sdk.NoteFilter(sdk.NoteFilterTypes.All)
      );
      const record =
        stored.find((n) => n.detailsCommitment().toHex() === noteDetailsHex) ??
        stored[stored.length - 1];
      const recordHex = record.detailsCommitment().toHex();

      return {
        recipientDigestHex,
        otherAmountHex,
        sameDetailsHex,
        noteDetailsHex,
        noteIdHex,
        noteCommitmentHex,
        outputFullHex,
        detailsHex,
        recordHex,
        storedCount: stored.length,
        differsFromId: noteDetailsHex !== noteIdHex,
        differsFromCommitment: noteDetailsHex !== noteCommitmentHex,
      };
    });

    expect(result.differsFromId).toBe(true);
    expect(result.differsFromCommitment).toBe(true);
    expect(result.noteDetailsHex).not.toBe(result.recipientDigestHex);
    expect(result.otherAmountHex).not.toBe(result.noteDetailsHex);
    expect(result.sameDetailsHex).toBe(result.noteDetailsHex);
    expect(result.outputFullHex).toBe(result.noteDetailsHex);
    expect(result.detailsHex).toBe(result.noteDetailsHex);
    expect(result.storedCount).toBeGreaterThan(0);
    expect(result.recordHex).toBe(result.noteDetailsHex);
  });
});

// BOUNDED NOTE READS
// =======================================================================================================
//
// A `NoteFilter` can carry caller-supplied nullifiers and be bounded to a page, so a list read hands
// JavaScript only the notes it asked for.

test.describe("bounded note reads", () => {
  test("pages stored notes and matches caller-supplied nullifiers", async ({
    run,
  }) => {
    const result = await run(async ({ sdk, helpers }) => {
      const mockClient = await helpers.createFreshMockClient();
      const sender = await mockClient.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512,
        new Uint8Array(32).fill(1)
      );
      const target = await mockClient.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512,
        new Uint8Array(32).fill(2)
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
      const address = sdk.Address.fromAccountId(target.id(), "BasicWallet");
      const proof = sdk.NoteInclusionProof.mockAtBlock(0);
      for (let amount = 10; amount < 17; amount++) {
        const note = sdk.Note.createP2IDNote(
          sender.id(),
          target.id(),
          new sdk.NoteAssets([
            new sdk.FungibleAsset(faucet.id(), sdk.u64(amount)),
          ]),
          sdk.NoteType.Private,
          new sdk.NoteAttachment()
        );
        await mockClient.sendPrivateNote(note, address, proof);
      }
      await mockClient.fetchPrivateNotes();

      const key = (note) => note.detailsCommitment().toHex();
      const all = await mockClient.getInputNotes(
        new sdk.NoteFilter(sdk.NoteFilterTypes.All)
      );
      const pages = [];
      let after;
      for (;;) {
        const page = await mockClient.getInputNotes(
          new sdk.NoteFilter(sdk.NoteFilterTypes.All).page(after, 3)
        );
        if (page.length === 0) break;
        pages.push(page.map(key));
        after = key(page[page.length - 1]);
      }

      const withNullifier = all.find((note) => note.nullifier());
      const byNullifier = (hex) =>
        mockClient.getInputNotes(
          new sdk.NoteFilter(
            sdk.NoteFilterTypes.Nullifiers,
            undefined,
            undefined,
            [sdk.Word.fromHex(hex)]
          )
        );
      const matching = await byNullifier(withNullifier.nullifier());
      const nonmatching = await byNullifier("0x" + "11".repeat(32));

      return {
        total: all.length,
        pages,
        matching: matching.map(key),
        expected: key(withNullifier),
        nonmatching: nonmatching.length,
      };
    });

    expect(result.total).toBe(7);
    expect(result.pages.map((page) => page.length)).toEqual([3, 3, 1]);
    const flat = result.pages.flat();
    expect(new Set(flat).size).toBe(7);
    expect(flat).toEqual([...flat].sort());
    expect(result.matching).toEqual([result.expected]);
    expect(result.nonmatching).toBe(0);
  });
});
