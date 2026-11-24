// @ts-nocheck
import { test, expect } from "./test-setup";

// XRESERVE BURN NOTE
// =======================================================================================================
//
// `Note.createXReserveBurnNote` builds the public burn note Circle's xReserve
// attester reads to release USDC on the destination chain. The expected
// withdrawal words are the upstream `bn-pos-typical` vector from miden-usdcx
// (tests/vectors/xreserve-encoding-vectors.json).

const EXPECTED_WITHDRAWAL_WORDS = [
  [6n, 0n, 0n, 0n],
  [0x14131211n, 0x18171615n, 0x1c1b1a19n, 0x201f1e1dn],
  [0x24232221n, 0x28272625n, 0x2c2b2a29n, 0x302f2e2dn],
];

test.describe("Note.createXReserveBurnNote", () => {
  test("matches the upstream burn-note vector", async ({ run }) => {
    const result = await run(async ({ sdk, helpers }) => {
      const mockClient = await helpers.createFreshMockClient();
      const sender = await mockClient.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512,
        new Uint8Array(32).fill(1)
      );
      const faucet = await mockClient.newFaucet(
        sdk.AccountStorageMode.public(),
        false,
        "USDC",
        "USDC",
        6,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      // `run` serializes this callback, so the vector cannot be closed over.
      const recipient = new Uint8Array(
        "1112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f30"
          .match(/../g)
          .map((byte) => parseInt(byte, 16))
      );

      if (typeof sdk.Note.createXReserveBurnNote !== "function") {
        return { missing: true };
      }
      const note = sdk.Note.createXReserveBurnNote(
        sender.id(),
        faucet.id(),
        sdk.u64(250),
        6,
        recipient
      );

      let shortRecipientError = "";
      try {
        sdk.Note.createXReserveBurnNote(
          sender.id(),
          faucet.id(),
          sdk.u64(250),
          6,
          recipient.slice(0, 31)
        );
      } catch (err) {
        shortRecipientError = String(err);
      }

      const metadata = note.metadata();
      const [asset] = note.assets().fungibleAssets();
      const attachments = note.attachments();
      return {
        missing: false,
        isPublic: metadata.noteType() === sdk.NoteType.Public,
        tag: metadata.tag().asU32(),
        senderMatches: metadata.sender().toString() === sender.id().toString(),
        faucetMatches: asset.faucetId().toString() === faucet.id().toString(),
        amount: asset.amount().toString(),
        attachmentCount: attachments.length,
        withdrawalWords: attachments[1]
          .toWords()
          .map((word) => word.toU64s().map(String)),
        shortRecipientError,
      };
    });

    expect(result.missing).toBe(false);
    expect(result.isPublic).toBe(true);
    expect(result.tag).toBe(0x4255524e);
    expect(result.senderMatches).toBe(true);
    expect(result.faucetMatches).toBe(true);
    expect(result.amount).toBe("250");
    expect(result.attachmentCount).toBe(2);
    expect(result.withdrawalWords).toEqual(
      EXPECTED_WITHDRAWAL_WORDS.map((word) => word.map(String))
    );
    expect(result.shortRecipientError).toMatch(/32 bytes/);
  });
});
