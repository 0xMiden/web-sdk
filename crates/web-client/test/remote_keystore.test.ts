import test from "./playwright.global.setup";

import { expect } from "@playwright/test";

test.describe("remote keystore", () => {
  test("includes the worker getKey timeout in transaction failures", async ({
    page,
  }) => {
    const message = await page.evaluate(async () => {
      const client =
        await window.WasmWebClient.createClientWithExternalKeystore(
          window.rpcUrl,
          undefined,
          undefined,
          `${window.storeName}-get-key-timeout`,
          () => new Promise<Uint8Array>(() => {}),
          async () => {},
          undefined,
          undefined,
          true,
          undefined,
          window.feeFaucetId,
          1000
        );
      const faucet = await client.newFaucet(
        window.AccountStorageMode.private(),
        false,
        "DAG",
        "DAG",
        8,
        BigInt(10000000),
        window.AuthScheme.AuthRpoFalcon512
      );
      await client.syncState();
      const wallet = await client.newWallet(
        window.AccountStorageMode.private(),
        window.AuthScheme.AuthRpoFalcon512,
        undefined
      );
      await client.syncState();
      const txRequest = await (client as any).newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        window.NoteType.Public,
        BigInt(1000)
      );

      try {
        await client.executeTransaction(faucet.id(), txRequest);
        return "transaction unexpectedly succeeded";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(message).toMatch(/Failed to get secret key via callback/);
    expect(message).toMatch(/Callback getKey-.+ timed out after 1000ms/);
    expect(message).not.toContain("JsValue(");
  });

  test("preserves an insertKey error in newWallet failures", async ({
    page,
  }) => {
    const message = await page.evaluate(async () => {
      const client =
        await window.WasmWebClient.createClientWithExternalKeystore(
          window.rpcUrl,
          undefined,
          undefined,
          `${window.storeName}-insert-key-error`,
          undefined,
          () =>
            Promise.reject(
              new Error("Callback insertKey-wallet timed out after 1000ms")
            ),
          undefined,
          undefined,
          true,
          undefined,
          window.feeFaucetId,
          1000
        );

      try {
        await client.newWallet(
          window.AccountStorageMode.private(),
          window.AuthScheme.AuthRpoFalcon512,
          undefined
        );
        return "wallet creation unexpectedly succeeded";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(message).toMatch(/Failed to insert key via callback/);
    expect(message).toMatch(/Callback insertKey-.+ timed out after 1000ms/);
    expect(message).not.toContain("JsValue(");
  });

  test("preserves a string insertKey rejection in newWallet failures", async ({
    page,
  }) => {
    const message = await page.evaluate(async () => {
      const client =
        await window.WasmWebClient.createClientWithExternalKeystore(
          window.rpcUrl,
          undefined,
          undefined,
          `${window.storeName}-insert-key-string-error`,
          undefined,
          () =>
            Promise.reject("Callback insertKey-string timed out after 1000ms"),
          undefined,
          undefined,
          true,
          undefined,
          window.feeFaucetId,
          1000
        );

      try {
        await client.newWallet(
          window.AccountStorageMode.private(),
          window.AuthScheme.AuthRpoFalcon512,
          undefined
        );
        return "wallet creation unexpectedly succeeded";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(message).toMatch(/Callback insertKey-string timed out after 1000ms/);
  });

  test("renders a synchronous insertKey throw on the direct callback path", async ({
    page,
  }) => {
    const message = await page.evaluate(async () => {
      const client =
        await window.WasmWebClient.createClientWithExternalKeystore(
          window.rpcUrl,
          undefined,
          undefined,
          `${window.storeName}-insert-key-sync-error-direct`,
          undefined,
          () => {
            throw new Error("synchronous insertKey failure");
          },
          undefined,
          undefined,
          false,
          undefined,
          window.feeFaucetId
        );

      try {
        await client.newWallet(
          window.AccountStorageMode.private(),
          window.AuthScheme.AuthRpoFalcon512,
          undefined
        );
        return "wallet creation unexpectedly succeeded";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(message).toContain("synchronous insertKey failure");
    expect(message).not.toContain("JsValue(");
  });

  test("renders a primitive insertKey rejection on the direct callback path", async ({
    page,
  }) => {
    const message = await page.evaluate(async () => {
      const client =
        await window.WasmWebClient.createClientWithExternalKeystore(
          window.rpcUrl,
          undefined,
          undefined,
          `${window.storeName}-insert-key-primitive-error-direct`,
          undefined,
          () => Promise.reject("primitive insertKey failure"),
          undefined,
          undefined,
          false,
          undefined,
          window.feeFaucetId
        );

      try {
        await client.newWallet(
          window.AccountStorageMode.private(),
          window.AuthScheme.AuthRpoFalcon512,
          undefined
        );
        return "wallet creation unexpectedly succeeded";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(message).toContain("primitive insertKey failure");
    expect(message).not.toContain("JsValue(");
  });

  test("should create a client with a remote keystore", async ({ page }) => {
    const client = await page.evaluate(async () => {
      const insertKeyCb = async (
        _publicKeyCommitment: string,
        _secretKey: string
      ) => {};
      const getKeyCb = async (_publicKeyCommitment: string) => {
        return undefined;
      };
      const signCb = async (_publicKeyCommitment: string, _message: string) => {
        return undefined;
      };
      const client = await window.helpers.createClientWithKeystore(
        getKeyCb,
        insertKeyCb,
        signCb
      );
      return client;
    });
    expect(client).toBeDefined();
  });

  test("should create a client with a remote keystore and insert a key", async ({
    page,
  }) => {
    const { publicKeyCommitment, secretKey } = await page.evaluate(async () => {
      let publicKeyCommitment: string | undefined;
      let secretKey: string | undefined;
      const insertKeyCb = async (
        publicKeyCommitmentStr: string,
        secretKeyStr: string
      ) => {
        publicKeyCommitment = publicKeyCommitmentStr;
        secretKey = secretKeyStr;
      };
      const client = await window.helpers.createClientWithKeystore(
        undefined,
        insertKeyCb,
        undefined
      );
      await client.newWallet(
        window.AccountStorageMode.private(),
        window.AuthScheme.AuthRpoFalcon512,
        undefined
      );

      return {
        publicKeyCommitment,
        secretKey,
      };
    });

    expect(publicKeyCommitment).toBeDefined();
    expect(secretKey).toBeDefined();
  });

  test("should call getKey callback with correct public key during export", async ({
    page,
  }) => {
    const { insertedPubKey, getKeyPubKey } = await page.evaluate(async () => {
      let insertedPubKey: number[] | undefined;
      let getKeyPubKey: number[] | undefined;

      const insertKeyCb = async (
        publicKeyCommitment: Uint8Array,
        _secretKey: Uint8Array
      ) => {
        insertedPubKey = Array.from(publicKeyCommitment);
      };

      const getKeyCb = async (publicKeyCommitment: Uint8Array) => {
        getKeyPubKey = Array.from(publicKeyCommitment);
        // Intentionally return undefined to cause export to fail after callback invocation
        return undefined;
      };

      const client = await window.helpers.createClientWithKeystore(
        getKeyCb,
        insertKeyCb,
        undefined
      );

      const wallet = await client.newWallet(
        window.AccountStorageMode.private(),
        window.AuthScheme.AuthRpoFalcon512,
        undefined
      );

      try {
        await (client as any).exportAccountFile(wallet.id());
      } catch (_e) {
        // Expected due to undefined return from getKeyCb; we only care that the callback was invoked
      }

      return { insertedPubKey, getKeyPubKey };
    });

    expect(insertedPubKey).toBeDefined();
    expect(getKeyPubKey).toBeDefined();
    expect(getKeyPubKey).toEqual(insertedPubKey);
  });

  test("should call sign callback with correct arguments during transaction", async ({
    page,
  }) => {
    const { faucetPubKey, signPubKey } = await page.evaluate(async () => {
      let faucetPubKey: number[] | undefined;
      let faucetSecretKey: Uint8Array | undefined;
      let signPubKey: number[] | undefined;

      const insertKeyCb = async (
        publicKeyCommitment: Uint8Array,
        secretKey: Uint8Array
      ) => {
        // Capture the faucet's public key (we will create the faucet first)
        if (!faucetPubKey) {
          faucetPubKey = Array.from(publicKeyCommitment);
          faucetSecretKey = secretKey;
        }
      };

      const signCb = async (
        publicKeyCommitment: Uint8Array,
        signingInputs: Uint8Array
      ) => {
        signPubKey = Array.from(publicKeyCommitment);
        const wasmSigningInputs =
          window.SigningInputs.deserialize(signingInputs);
        const wasmSecretKey = window.AuthSecretKey.deserialize(
          faucetSecretKey!
        );
        const signature = wasmSecretKey.signData(wasmSigningInputs);
        const serializedSig = signature.serialize();
        return serializedSig;
      };

      const client = await window.helpers.createClientWithKeystore(
        undefined,
        insertKeyCb,
        signCb
      );

      // Create faucet first so insertKeyCb captures its public key
      const faucet = await client.newFaucet(
        window.AccountStorageMode.private(),
        false,
        "DAG",
        "DAG",
        8,
        BigInt(10000000),
        window.AuthScheme.AuthRpoFalcon512
      );

      await client.syncState();

      const wallet = await client.newWallet(
        window.AccountStorageMode.private(),
        window.AuthScheme.AuthRpoFalcon512,
        undefined
      );

      await client.syncState();

      const txRequest = await (client as any).newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        window.NoteType.Public,
        BigInt(1000)
      );

      // This call should trigger the sign callback
      await client.executeTransaction(faucet.id(), txRequest);

      return { faucetPubKey, signPubKey };
    });

    expect(faucetPubKey).toBeDefined();
    expect(signPubKey).toBeDefined();
    expect(signPubKey).toEqual(faucetPubKey);
  });
});
