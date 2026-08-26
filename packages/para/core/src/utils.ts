import ParaWeb, { Wallet } from "@getpara/web-sdk";
import type { NoteType, TransactionSummary } from "@miden-sdk/miden-sdk";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { TxSummaryJson } from "./types";
/** @public */
export { hexToBytes };

/**
 * Converts a Para hex signature into the serialized format expected by Miden.
 * Prefixes the auth scheme byte and appends the extra padding byte required by current crypto libs.
 */
export const fromHexSig = (hexString: string) => {
  if (hexString.length % 2 !== 0) {
    throw new Error("Invalid string len");
  }
  const sigBytes = hexToBytes(hexString);
  const serialized = new Uint8Array(sigBytes.length + 2);
  serialized[0] = 1; // Auth scheme for ECDSA
  serialized.set(sigBytes, 1);
  // TODO: bug in miden crypto where there is an extra byte in the serialized signature
  return serialized;
};

/**
 * Derives a 32-byte seed buffer from a UTF-8 string, truncating when longer than 32 bytes.
 */
export const accountSeedFromStr = (str?: string) => {
  if (!str) return;
  const buffer = new Uint8Array(32);
  const bytes = utf8ToBytes(str);
  buffer.set(bytes.slice(0, 32));
  return buffer;
};

/**
 * Converts an uncompressed EVM public key into a Miden commitment.
 * Assumes input format `0x04${x}${y}` where x and y are 64-char hex strings.
 *
 * The protocol commits to the affine point as Poseidon2 over 16 field elements:
 * the x coordinate then the y coordinate, each as eight 32-bit limbs in
 * little-endian limb order. 0.15 hashed a different preimage — nine felts
 * packed from the 33-byte compressed SEC1 encoding — so a commitment computed
 * by an older release will not match one computed here.
 */
export const evmPkToCommitment = async (uncompressedPublicKey: string) => {
  const { Felt, Poseidon2, FeltArray } = await import("@miden-sdk/miden-sdk");
  const withoutPrefix = uncompressedPublicKey.slice(4);
  const x = withoutPrefix.slice(0, 64);
  const y = withoutPrefix.slice(64);

  const felts = [...coordToLimbs(x), ...coordToLimbs(y)].map(
    (limb) => new Felt(BigInt(limb))
  );

  return Poseidon2.hashElements(new FeltArray(felts));
};

/**
 * Splits a 32-byte big-endian coordinate into eight 32-bit limbs, least
 * significant limb first — the representation the protocol hashes.
 */
const coordToLimbs = (hex: string): number[] => {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) {
    throw new Error(`Expected a 32-byte coordinate, got ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const limbs: number[] = [];
  for (let i = 7; i >= 0; i--) {
    limbs.push(view.getUint32(i * 4, false));
  }
  return limbs;
};

/**
 * Retrieves the uncompressed public key for a Para wallet, falling back to JWT data when absent.
 */
export const getUncompressedPublicKeyFromWallet = async (
  para: ParaWeb,
  wallet: Wallet
) => {
  let publicKey = wallet.publicKey;
  if (!publicKey) {
    const { token } = await para.issueJwt();
    const payload = JSON.parse(window.atob(token.split(".")[1]));
    if (!payload.data) {
      throw new Error("Got invalid jwt token");
    }
    const wallets = payload.data.connectedWallets;
    const w = wallets.find((w) => w.id === wallet.id);
    if (!w) {
      throw new Error("Wallet Not Found in jwt data");
    }
    publicKey = w.publicKey;
  }
  return publicKey;
};

export const txSummaryToJson = (
  txSummary: TransactionSummary
): TxSummaryJson => {
  const inputNotes = txSummary
    .inputNotes()
    .notes()
    .map((inputNote) => ({
      id: inputNote.id().toString(),
      assets: inputNote
        .note()
        .assets()
        .fungibleAssets()
        .map((asset) => {
          return {
            assetId: asset.faucetId().toString(),
            amount: asset.amount().toString(),
          };
        }),
      sender: inputNote.note().metadata().sender().toString(),
    }));

  const outputNotes = txSummary
    .outputNotes()
    .notes()
    .map((outputNote) => ({
      id: outputNote.id().toString(),
      assets: outputNote
        .assets()
        .fungibleAssets()
        .map((asset) => {
          return {
            assetId: asset.faucetId().toString(),
            amount: asset.amount().toString(),
          };
        }),
      noteType: noteTypeToString(outputNote.metadata().noteType()),
    }));

  return {
    inputNotes,
    outputNotes,
  };
};

function noteTypeToString(noteType: NoteType) {
  // protocol 0.15 NoteType encoding: Private = 0, Public = 1.
  switch (noteType) {
    case 1:
      return "public";
    case 0:
      return "private";
    default:
      return "UNKNOWN";
  }
}
