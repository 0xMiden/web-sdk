// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("account component auth constructors", () => {
  test("createAuthComponentFromCommitment matches secret-key variant (Falcon, authScheme=2)", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.rpoFalconWithRNG();
      const commitment = secretKey.publicKey().toCommitment();

      const fromSecret =
        sdk.AccountComponent.createAuthComponentFromSecretKey(secretKey);
      const fromCommitment =
        sdk.AccountComponent.createAuthComponentFromCommitment(commitment, 2);

      const proceduresFromComponent = (component) =>
        component
          .getProcedures()
          .map((procedure) => procedure.digest.toHex())
          .sort();

      return {
        fromSecretProcs: JSON.stringify(proceduresFromComponent(fromSecret)),
        fromCommitmentProcs: JSON.stringify(
          proceduresFromComponent(fromCommitment)
        ),
      };
    });
    expect(result.fromSecretProcs).toEqual(result.fromCommitmentProcs);
  });

  test("createAuthComponentFromCommitment matches secret-key variant (ECDSA, authScheme=1)", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const secretKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const commitment = secretKey.publicKey().toCommitment();

      const fromSecret =
        sdk.AccountComponent.createAuthComponentFromSecretKey(secretKey);
      const fromCommitment =
        sdk.AccountComponent.createAuthComponentFromCommitment(commitment, 1);

      const proceduresFromComponent = (component) =>
        component
          .getProcedures()
          .map((procedure) => procedure.digest.toHex())
          .sort();

      return {
        fromSecretProcs: JSON.stringify(proceduresFromComponent(fromSecret)),
        fromCommitmentProcs: JSON.stringify(
          proceduresFromComponent(fromCommitment)
        ),
      };
    });
    expect(result.fromSecretProcs).toEqual(result.fromCommitmentProcs);
  });
});

// The package's AuthScheme is { Falcon: "falcon", ECDSA: "ecdsa" }. The test
// harness puts the wasm enum on `sdk.AuthScheme`, so the strings are spelled
// out here and the enum gives the numeric value to compare against.
test.describe("friendly AuthScheme in the auth-scheme bindings", () => {
  test("createAuthComponentFromCommitment builds the same component for the string and the enum value", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const procedures = (component) =>
        JSON.stringify(
          component
            .getProcedures()
            .map((procedure) => procedure.digest.toHex())
            .sort()
        );
      const fromCommitment = (secretKey, scheme) =>
        procedures(
          sdk.AccountComponent.createAuthComponentFromCommitment(
            secretKey.publicKey().toCommitment(),
            scheme
          )
        );
      const ecdsaKey = sdk.AuthSecretKey.ecdsaWithRNG();
      const falconKey = sdk.AuthSecretKey.rpoFalconWithRNG();
      let missing;
      try {
        fromCommitment(ecdsaKey, undefined);
      } catch (error) {
        missing = String(error?.message ?? error);
      }
      return {
        ecdsa: fromCommitment(ecdsaKey, "ecdsa"),
        ecdsaEnum: fromCommitment(ecdsaKey, sdk.AuthScheme.AuthEcdsaK256Keccak),
        ecdsaSecret: procedures(
          sdk.AccountComponent.createAuthComponentFromSecretKey(ecdsaKey)
        ),
        falcon: fromCommitment(falconKey, "falcon"),
        falconSecret: procedures(
          sdk.AccountComponent.createAuthComponentFromSecretKey(falconKey)
        ),
        missing,
      };
    });
    expect(result.ecdsa).toEqual(result.ecdsaEnum);
    expect(result.ecdsa).toEqual(result.ecdsaSecret);
    expect(result.falcon).toEqual(result.falconSecret);
    expect(result.missing).toContain(
      "AccountComponent.createAuthComponentFromCommitment requires an auth scheme"
    );
  });

  test("AuthGuardedMultisigConfig builds the same account for the string and the enum value", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const word = (n) => new sdk.Word(sdk.u64Array([n, 0, 0, 0]));
      const accountId = (scheme) => {
        const config = new sdk.AuthGuardedMultisigConfig(
          [word(4), word(5)],
          1,
          word(6),
          scheme
        );
        const seed = new Uint8Array(32);
        seed.fill(0x33);
        return new sdk.AccountBuilder(seed)
          .withAuthComponent(sdk.createAuthGuardedMultisig(config))
          .withBasicWalletComponent()
          .storageMode(sdk.AccountStorageMode.public())
          .build()
          .account.id()
          .toString();
      };
      const error = (scheme) => {
        try {
          accountId(scheme);
          return undefined;
        } catch (caught) {
          return String(caught?.message ?? caught);
        }
      };
      return {
        ecdsa: accountId("ecdsa"),
        ecdsaEnum: accountId(sdk.AuthScheme.AuthEcdsaK256Keccak),
        falcon: accountId("falcon"),
        falconEnum: accountId(sdk.AuthScheme.AuthRpoFalcon512),
        unknown: error("rsa"),
        missing: error(undefined),
      };
    });
    expect(result.ecdsa).toEqual(result.ecdsaEnum);
    expect(result.falcon).toEqual(result.falconEnum);
    expect(result.ecdsa).not.toEqual(result.falcon);
    expect(result.unknown).toContain('Unknown auth scheme: "rsa"');
    expect(result.missing).toContain(
      "AuthGuardedMultisigConfig requires an auth scheme"
    );
  });
});
