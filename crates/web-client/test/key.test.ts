// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("signature", () => {
  test("should produce a valid signature: Falcon Scheme", async ({ run }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.rpoFalconWithRNG();
      const message = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const signature = secretKey.sign(message);
      return secretKey.publicKey().verify(message, signature);
    });
    expect(result).toEqual(true);
  });

  test("should produce a valid signature: ECDSA Scheme", async ({ run }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const message = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const signature = secretKey.sign(message);
      return secretKey.publicKey().verify(message, signature);
    });
    expect(result).toEqual(true);
  });

  test("should not verify the wrong message: Falcon Scheme", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.rpoFalconWithRNG();
      const message = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const wrongMessage = new sdk.Word(sdk.u64Array([5, 6, 7, 8]));
      const signature = secretKey.sign(message);
      return secretKey.publicKey().verify(wrongMessage, signature);
    });
    expect(result).toEqual(false);
  });

  test("should not verify the wrong message: ECDSA Scheme", async ({ run }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const message = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const wrongMessage = new sdk.Word(sdk.u64Array([5, 6, 7, 8]));
      const signature = secretKey.sign(message);
      return secretKey.publicKey().verify(wrongMessage, signature);
    });
    expect(result).toEqual(false);
  });

  test("should not verify the signature of a different key: Falcon Scheme", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.rpoFalconWithRNG();
      const message = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const signature = secretKey.sign(message);
      const differentSecretKey = sdk.AuthSecretKey.rpoFalconWithRNG();
      return differentSecretKey.publicKey().verify(message, signature);
    });
    expect(result).toEqual(false);
  });

  test("should not verify the signature of a different key: ECDSA Scheme", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const message = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const signature = secretKey.sign(message);
      const differentSecretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      return differentSecretKey.publicKey().verify(message, signature);
    });
    expect(result).toEqual(false);
  });

  test("should be able to serialize and deserialize a signature: Falcon Scheme", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.rpoFalconWithRNG();
      const message = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const signature = secretKey.sign(message);
      const serializedSignature = signature.serialize();
      const deserializedSignature =
        sdk.Signature.deserialize(serializedSignature);
      return secretKey.publicKey().verify(message, deserializedSignature);
    });
    expect(result).toEqual(true);
  });

  test("should be able to serialize and deserialize a signature: ECDSA Scheme", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const message = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const signature = secretKey.sign(message);
      const serializedSignature = signature.serialize();
      const deserializedSignature =
        sdk.Signature.deserialize(serializedSignature);
      return secretKey.publicKey().verify(message, deserializedSignature);
    });
    expect(result).toEqual(true);
  });
});

test.describe("public key", () => {
  test("should be able to serialize and deserialize a public key: Falcon Scheme", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.rpoFalconWithRNG();
      const publicKey = secretKey.publicKey();
      const serializedPublicKey = publicKey.serialize();
      const deserializedPublicKey =
        sdk.PublicKey.deserialize(serializedPublicKey);
      const serializedDeserializedPublicKey = deserializedPublicKey.serialize();
      return {
        original: serializedPublicKey.toString(),
        roundtripped: serializedDeserializedPublicKey.toString(),
      };
    });
    expect(result.original).toEqual(result.roundtripped);
  });

  test("should be able to serialize and deserialize a public key: ECDSA Scheme", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const publicKey = secretKey.publicKey();
      const serializedPublicKey = publicKey.serialize();
      const deserializedPublicKey =
        sdk.PublicKey.deserialize(serializedPublicKey);
      const serializedDeserializedPublicKey = deserializedPublicKey.serialize();
      return {
        original: serializedPublicKey.toString(),
        roundtripped: serializedDeserializedPublicKey.toString(),
      };
    });
    expect(result.original).toEqual(result.roundtripped);
  });
});

test.describe("signing inputs", () => {
  test("should be able to sign and verify an arbitrary array of felts: Falcon Scheme", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.rpoFalconWithRNG();
      const otherSecretKey = sdk.AuthSecretKey.rpoFalconWithRNG();
      const message = Array.from(
        { length: 128 },
        (_, i) => new sdk.Felt(sdk.u64(i))
      );
      const signingInputs = sdk.SigningInputs.newArbitrary(message);
      const signature = secretKey.signData(signingInputs);
      const isValid = secretKey
        .publicKey()
        .verifyData(signingInputs, signature);
      const isValidOther = otherSecretKey
        .publicKey()
        .verifyData(signingInputs, signature);
      return { isValid, isValidOther };
    });
    expect(result.isValid).toBe(true);
    expect(result.isValidOther).toBe(false);
  });

  test("should be able to sign and verify an arbitrary array of felts: ECDSA Scheme", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const otherSecretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const message = Array.from(
        { length: 128 },
        (_, i) => new sdk.Felt(sdk.u64(i))
      );
      const signingInputs = sdk.SigningInputs.newArbitrary(message);
      const signature = secretKey.signData(signingInputs);
      const isValid = secretKey
        .publicKey()
        .verifyData(signingInputs, signature);
      const isValidOther = otherSecretKey
        .publicKey()
        .verifyData(signingInputs, signature);
      return { isValid, isValidOther };
    });
    expect(result.isValid).toBe(true);
    expect(result.isValidOther).toBe(false);
  });

  test("should be able to sign and verify a blind word: Falcon Scheme", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.rpoFalconWithRNG();
      const otherSecretKey = sdk.AuthSecretKey.rpoFalconWithRNG();
      const message = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const signingInputs = sdk.SigningInputs.newBlind(message);
      const signature = secretKey.signData(signingInputs);
      const isValid = secretKey
        .publicKey()
        .verifyData(signingInputs, signature);
      const isValidOther = otherSecretKey
        .publicKey()
        .verifyData(signingInputs, signature);
      return { isValid, isValidOther };
    });
    expect(result.isValid).toBe(true);
    expect(result.isValidOther).toBe(false);
  });

  test("should be able to sign and verify a blind word: ECDSA Scheme", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const otherSecretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const message = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const signingInputs = sdk.SigningInputs.newBlind(message);
      const signature = secretKey.signData(signingInputs);
      const isValid = secretKey
        .publicKey()
        .verifyData(signingInputs, signature);
      const isValidOther = otherSecretKey
        .publicKey()
        .verifyData(signingInputs, signature);
      return { isValid, isValidOther };
    });
    expect(result.isValid).toBe(true);
    expect(result.isValidOther).toBe(false);
  });
  test("domainSeparatedSignCommitment matches the published tag and vectors", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const b64 = (s: string) =>
        Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const hex = (w: any) => w.toHex();
      const tag = sdk.Poseidon2.hashElements(
        new sdk.FeltArray(
          Array.from(
            new TextEncoder().encode("miden-wallet/sign-bytes/v1"),
            (b) => new sdk.Felt(BigInt(b))
          )
        )
      );
      return {
        tag: Array.from(tag.toU64s() as BigUint64Array, (v) => v.toString(16)),
        word: hex(
          sdk.domainSeparatedSignCommitment(
            b64("AQAAAAAAAAACAAAAAAAAAAMAAAAAAAAABAAAAAAAAAA="),
            "word"
          )
        ),
        blind: hex(
          sdk.domainSeparatedSignCommitment(
            b64("AgEAAAAAAAAAAgAAAAAAAAADAAAAAAAAAAQAAAAAAAAA"),
            "signingInputs"
          )
        ),
        arbitrary: hex(
          sdk.domainSeparatedSignCommitment(
            b64("AQcFAAAAAAAAAAYAAAAAAAAABwAAAAAAAAA="),
            "signingInputs"
          )
        ),
      };
    });
    expect(result.tag).toEqual([
      "38a8bcdddf30cacf",
      "240d1b8455bc2c58",
      "18162f6af29602dd",
      "5385955edcd341a4",
    ]);
    const wordVector =
      "0x110a1b1c3b8cc8a4e0ed9acebb00996abdb93e7228280e2547edbdf9c268bee9";
    expect(result.word).toBe(wordVector);
    expect(result.blind).toBe(wordVector);
    expect(result.arbitrary).toBe(
      "0x8d7fafd3929b6cb5b0375bf0a5ab4f17b1a1948baefea1bb8067807021571d57"
    );
  });

  test("a signature over it does not verify as the raw word", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const word = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const tag = sdk.Poseidon2.hashElements(
        new sdk.FeltArray(
          Array.from(
            new TextEncoder().encode("miden-wallet/sign-bytes/v1"),
            (b) => new sdk.Felt(BigInt(b))
          )
        )
      );
      const signature = secretKey.signData(
        sdk.SigningInputs.newArbitrary([...tag.toFelts(), ...word.toFelts()])
      );
      const publicKey = secretKey.publicKey();
      const domain = sdk.domainSeparatedSignCommitment(
        word.serialize(),
        "word"
      );
      return {
        domain: publicKey.verify(domain, signature),
        raw: publicKey.verify(word, signature),
      };
    });
    expect(result.domain).toBe(true);
    expect(result.raw).toBe(false);
  });
});
