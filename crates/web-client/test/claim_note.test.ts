// @ts-nocheck
import { readFileSync } from "node:fs";
import { test, expect } from "./test-setup";

// CLAIM NOTE
// =======================================================================================================
//
// `Note.createClaimNote` builds the public CLAIM note the AggLayer bridge
// consumes to mint a bridged-in deposit. The vectors are miden-agglayer 0.18.0
// `solidity-compat/test-vectors/claim_asset_vectors_{l1,l2}_tx.json`: an L1
// (mainnet) deposit and an L2 (rollup) deposit.

const VECTORS = {
  l1: "claim_asset_vectors_l1_tx.json",
  l2: "claim_asset_vectors_l2_tx.json",
};

function loadVector(file) {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/agglayer/${file}`, import.meta.url),
      "utf8"
    )
  );
}

// Bytes packed four at a time into little-endian u32 felts, as upstream
// `bytes_to_packed_u32_elements` does.
function packed(hex) {
  const bytes = hex
    .slice(2)
    .match(/../g)
    .map((byte) => parseInt(byte, 16));
  const felts = [];
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = [0, 1, 2, 3].map((j) => bytes[i + j] ?? 0);
    felts.push(
      String(
        chunk[0] + chunk[1] * 2 ** 8 + chunk[2] * 2 ** 16 + chunk[3] * 2 ** 24
      )
    );
  }
  return felts;
}

function byteSwapped(n) {
  return String(new DataView(new Uint32Array([n]).buffer).getUint32(0, false));
}

function amountHex(decimal) {
  return "0x" + BigInt(decimal).toString(16).padStart(64, "0");
}

function expectedStorage(v, midenAmount) {
  return [
    ...v.smt_proof_local_exit_root.flatMap(packed),
    ...v.smt_proof_rollup_exit_root.flatMap(packed),
    ...packed(v.global_index),
    ...packed(v.mainnet_exit_root),
    ...packed(v.rollup_exit_root),
    "0",
    byteSwapped(v.origin_network),
    ...packed(v.origin_token_address),
    byteSwapped(v.destination_network),
    ...packed(v.destination_address),
    ...packed(amountHex(v.amount)),
    ...packed(v.metadata_hash),
    "0",
    "0",
    "0",
    midenAmount,
  ];
}

// `run` serializes its callback, so the vector is embedded in the source of a
// fresh function rather than closed over.
function claimNoteProbe(vector, scale) {
  const source = `async ({ sdk, helpers }) => {
    const v = ${JSON.stringify(vector)};
    const scale = ${scale};
    if (typeof sdk.Note.createClaimNote !== "function") {
      return { missing: true };
    }
    const mockClient = await helpers.createFreshMockClient();
    const sender = await mockClient.newWallet(
      sdk.AccountStorageMode.private(),
      sdk.AuthScheme.AuthRpoFalcon512,
      new Uint8Array(32).fill(1)
    );
    const bridge = await mockClient.newWallet(
      sdk.AccountStorageMode.public(),
      sdk.AuthScheme.AuthRpoFalcon512,
      new Uint8Array(32).fill(2)
    );
    const proof = () =>
      new sdk.ClaimProofData(
        v.smt_proof_local_exit_root,
        v.smt_proof_rollup_exit_root,
        v.global_index,
        v.mainnet_exit_root,
        v.rollup_exit_root
      );
    const leaf = (amount) =>
      new sdk.ClaimLeafData(
        v.origin_network,
        sdk.EthAddress.fromHex(v.origin_token_address),
        v.destination_network,
        sdk.EthAddress.fromHex(v.destination_address),
        amount,
        v.metadata_hash
      );
    const errorOf = (fn) => {
      try {
        fn();
        return "";
      } catch (err) {
        return String(err);
      }
    };

    const note = sdk.Note.createClaimNote(
      proof(),
      leaf(v.amount),
      scale,
      bridge.id(),
      sender.id()
    );
    const metadata = note.metadata();
    const attachments = note.attachments();
    const create = (amount, s) => () =>
      sdk.Note.createClaimNote(proof(), leaf(amount), s, bridge.id(), sender.id());
    return {
      missing: false,
      isPublic: metadata.noteType() === sdk.NoteType.Public,
      senderMatches: metadata.sender().toString() === sender.id().toString(),
      assetCount: note.assets().fungibleAssets().length,
      isNetworkNote: note.isNetworkNote(),
      attachmentCount: attachments.length,
      targetMatches:
        sdk.NetworkAccountTarget.fromAttachment(attachments[0])
          .targetId()
          .toString() === bridge.id().toString(),
      storage: note
        .recipient()
        .storage()
        .items()
        .map((felt) => felt.asInt().toString()),
      scaleTooLargeError: errorOf(create(v.amount, 19)),
      overflowError: errorOf(create(v.amount, 0)),
      aboveMaxError: errorOf(create(v.amount, 1)),
      nonDecimalError: errorOf(create("0x10", scale)),
      shortProofError: errorOf(() =>
        new sdk.ClaimProofData(
          v.smt_proof_local_exit_root.slice(1),
          v.smt_proof_rollup_exit_root,
          v.global_index,
          v.mainnet_exit_root,
          v.rollup_exit_root
        )
      ),
    };
  }`;
  return new Function("return " + source)();
}

test.describe("Note.createClaimNote", () => {
  for (const [direction, file] of Object.entries(VECTORS)) {
    test(`matches the upstream ${direction} claim vector`, async ({ run }) => {
      const vector = loadVector(file);
      // 1e20 base units at scale 10 is 1e10 Miden units.
      const result = await run(claimNoteProbe(vector, 10));

      expect(result.missing).toBe(false);
      expect(result.isPublic).toBe(true);
      expect(result.senderMatches).toBe(true);
      expect(result.assetCount).toBe(0);
      expect(result.isNetworkNote).toBe(true);
      expect(result.attachmentCount).toBe(1);
      expect(result.targetMatches).toBe(true);
      expect(result.storage).toEqual(expectedStorage(vector, "10000000000"));

      expect(result.scaleTooLargeError).toMatch(/scaling factor too large/);
      expect(result.overflowError).toMatch(/doesn't fit in u64/);
      expect(result.aboveMaxError).toMatch(/maximum fungible token amount/);
      expect(result.nonDecimalError).toMatch(/amount/);
      expect(result.shortProofError).toMatch(/32/);
    });
  }
});
