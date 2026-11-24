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

  test("recoverFrom recovers the signer's public key: Falcon Scheme", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.rpoFalconWithRNG();
      const message = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const signature = secretKey.sign(message);
      const recovered = sdk.PublicKey.recoverFrom(message, signature);
      return {
        commitmentMatches:
          recovered.toCommitment().toHex() ===
          secretKey.publicKey().toCommitment().toHex(),
        verifies: recovered.verify(message, signature),
      };
    });
    expect(result).toEqual({ commitmentMatches: true, verifies: true });
  });

  test("recoverFrom recovers the signer's public key: ECDSA Scheme", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const otherSecretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const message = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const signature = secretKey.sign(message);
      const recovered = sdk.PublicKey.recoverFrom(message, signature);
      return {
        commitmentMatches:
          recovered.toCommitment().toHex() ===
          secretKey.publicKey().toCommitment().toHex(),
        otherCommitmentDiffers:
          recovered.toCommitment().toHex() !==
          otherSecretKey.publicKey().toCommitment().toHex(),
        verifies: recovered.verify(message, signature),
      };
    });
    expect(result).toEqual({
      commitmentMatches: true,
      otherCommitmentDiffers: true,
      verifies: true,
    });
  });

  test("recoverFrom on another word still returns the Falcon key", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.rpoFalconWithRNG();
      const signed = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const other = new sdk.Word(sdk.u64Array([5, 6, 7, 8]));
      const signature = secretKey.sign(signed);
      const recovered = sdk.PublicKey.recoverFrom(other, signature);
      return {
        commitmentMatches:
          recovered.toCommitment().toHex() ===
          secretKey.publicKey().toCommitment().toHex(),
        verifyOther: recovered.verify(other, signature),
        verifySigned: recovered.verify(signed, signature),
      };
    });
    expect(result).toEqual({
      commitmentMatches: true,
      verifyOther: false,
      verifySigned: true,
    });
  });

  test("recoverFrom on another word does not return the ECDSA signer", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const signed = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      const other = new sdk.Word(sdk.u64Array([5, 6, 7, 8]));
      const signature = secretKey.sign(signed);
      try {
        const recovered = sdk.PublicKey.recoverFrom(other, signature);
        return {
          rejected:
            recovered.toCommitment().toHex() !==
            secretKey.publicKey().toCommitment().toHex(),
        };
      } catch {
        return { rejected: true };
      }
    });
    expect(result).toEqual({ rejected: true });
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
  test("domainSeparatedSignCommitment matches the published vectors", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const b64 = (s: string) =>
        Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const hex = (w: any) => w.toHex();
      return {
        word: hex(
          sdk.domainSeparatedSignCommitment(
            b64("AQAAAAAAAAACAAAAAAAAAAMAAAAAAAAABAAAAAAAAAA="),
            "word"
          )
        ),
        blind: hex(
          sdk.domainSeparatedSignCommitment(
            b64("GiIKIAEAAAAAAAAAAgAAAAAAAAADAAAAAAAAAAQAAAAAAAAA"),
            "signingInputs"
          )
        ),
        arbitrary: hex(
          sdk.domainSeparatedSignCommitment(
            b64("EiEKCQkFAAAAAAAAAAoJCQYAAAAAAAAACgkJBwAAAAAAAAA="),
            "signingInputs"
          )
        ),
      };
    });
    const wordVector =
      "0x4bd9dfb6469ea54bcc66f4eaa255305561d0b6749b6ab80d5760969b5bd59e57";
    expect(result.word).toBe(wordVector);
    expect(result.blind).toBe(wordVector);
    expect(result.arbitrary).toBe(
      "0x9a5dcb2f7119b5020c904fd8a65a2e138a145ecda5ebd149d7dd0c4e2561f12d"
    );
  });

  test("a signature over it does not verify as the raw word", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const word = new sdk.Word(sdk.u64Array([1, 2, 3, 4]));
      // The wallet's domain tag, the Poseidon2 hash of "miden-wallet/sign-bytes/v1".
      const tag = [
        0x38a8bcdddf30cacfn,
        0x240d1b8455bc2c58n,
        0x18162f6af29602ddn,
        0x5385955edcd341a4n,
      ].map((v) => new sdk.Felt(v));
      const signature = secretKey.signData(
        sdk.SigningInputs.newArbitrary([...tag, ...word.toFelts()])
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
