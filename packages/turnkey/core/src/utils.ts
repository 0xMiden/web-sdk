import type { Turnkey } from "./types.js";

export const fromTurnkeySig = (sig: { r: string; s: string; v: string }) => {
  // TODO: bug in miden crypto where there is an extra byte in the signature buffer
  const sigBuff = new Uint8Array(67);
  sigBuff[0] = 1;
  const rBytes = hexToBytes(sig.r);
  const sBytes = hexToBytes(sig.s);

  sigBuff.set(rBytes, 1);
  sigBuff.set(sBytes, 33);
  sigBuff[65] = parseInt(sig.v);
  return sigBuff;
};

/** @public */
export const hexToBytes = (hex: string): Uint8Array => {
  if (hex.startsWith("0x")) {
    hex = hex.slice(2);
  }
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(`${hex[i]}${hex[i + 1]}`, 16);
  }
  return bytes;
};

/** @public */
export async function fetchUncompressedPublicKey(input: {
  client: Turnkey;
  privateKeyId: string;
  organizationId: string;
}): Promise<string> {
  const { client, privateKeyId, organizationId } = input;

  const keyInfo = await client.getPrivateKey({
    organizationId,
    privateKeyId,
  });

  const uncompressedPublicKey = keyInfo.privateKey.publicKey;
  return uncompressedPublicKey;
}

/** @public */
export function isValidUuid(s: string): boolean {
  const regex = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  return regex.test(s);
}

/**
 * Converts a compressed SEC1 public key into a Miden commitment.
 *
 * The protocol commits to the affine point as Poseidon2 over 16 field elements:
 * the x coordinate then the y coordinate, each as eight 32-bit limbs in
 * little-endian limb order. A compressed key carries only x and a parity bit,
 * so y is recovered here. 0.15 hashed a different preimage — nine felts packed
 * from the compressed encoding, which needed no decompression — so a commitment
 * computed by an older release will not match one computed here.
 */
export const evmPkToCommitment = async (compressedPk: string) => {
  const { Felt, Poseidon2, FeltArray } = await import("@miden-sdk/miden-sdk");
  const bytes = hexToBytes(compressedPk);
  if (bytes.length !== 33) {
    throw new Error(`Expected a 33-byte compressed key, got ${bytes.length}`);
  }

  const x = bytesToBigInt(bytes.subarray(1, 33));
  const y = decompressY(x, bytes[0]);

  const felts = [...coordToLimbs(x), ...coordToLimbs(y)].map(
    (limb) => new Felt(BigInt(limb))
  );

  return Poseidon2.hashElements(new FeltArray(felts));
};

/** secp256k1 field prime. */
const SECP256K1_P = (1n << 256n) - (1n << 32n) - 977n;

const bytesToBigInt = (bytes: Uint8Array): bigint =>
  bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);

const modPow = (base: bigint, exp: bigint, mod: bigint): bigint => {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
};

/**
 * Recovers y from a compressed point. secp256k1 has p ≡ 3 (mod 4), so the
 * square root is a single exponentiation; the result is verified against the
 * curve equation rather than trusted, and negated when its parity disagrees
 * with the prefix byte.
 */
const decompressY = (x: bigint, prefix: number): bigint => {
  if (prefix !== 0x02 && prefix !== 0x03) {
    throw new Error(`Invalid compressed key prefix 0x${prefix.toString(16)}`);
  }
  const alpha = (modPow(x, 3n, SECP256K1_P) + 7n) % SECP256K1_P;
  let y = modPow(alpha, (SECP256K1_P + 1n) / 4n, SECP256K1_P);
  if ((y * y) % SECP256K1_P !== alpha) {
    throw new Error("Compressed key is not a point on secp256k1");
  }
  if ((y & 1n) !== BigInt(prefix & 1)) {
    y = SECP256K1_P - y;
  }
  return y;
};

/**
 * Splits a coordinate into eight 32-bit limbs, least significant limb first —
 * the representation the protocol hashes.
 */
const coordToLimbs = (value: bigint): number[] => {
  const limbs: number[] = [];
  let v = value;
  for (let i = 0; i < 8; i++) {
    limbs.push(Number(v & 0xffffffffn));
    v >>= 32n;
  }
  return limbs;
};

/**
 * Derives a 32-byte seed buffer from a UTF-8 string, truncating when longer than 32 bytes.
 */
export const accountSeedFromStr = (str?: string) => {
  if (!str) return;
  const buffer = new Uint8Array(32);
  const bytes = new TextEncoder().encode(str);
  buffer.set(bytes.slice(0, 32));
  return buffer;
};
