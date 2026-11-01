import test from "./playwright.global.setup";

import { expect } from "@playwright/test";

test.describe("remote keystore", () => {
  for (const useWorker of [true, false]) {
    test(`includes getKey failure details and clears them on retry (worker: ${useWorker})`, async ({
      page,
    }) => {
      const {
        failedMessage,
        retrySucceeded,
        failedLookupCalls,
        retryLookupCalls,
        authErrorMessage,
        retryAuthError,
      } = await page.evaluate(async (useWorker) => {
        let failLookup = true;
        let getKeyCalls = 0;
        const keys = new Map<string, Uint8Array>();
        const client =
          await window.WasmWebClient.createClientWithExternalKeystore(
            window.rpcUrl,
            undefined,
            undefined,
            `${window.storeName}-get-key-timeout`,
            (commitment: Uint8Array) => {
              getKeyCalls++;
              if (!failLookup)
                return Promise.resolve(
                  keys.get(Array.from(commitment).join(","))
                );
              if (useWorker) return new Promise<Uint8Array>(() => {});
              return Promise.reject(
                new Error("Callback getKey-direct timed out after 1000ms")
              );
            },
            async (commitment: Uint8Array, key: Uint8Array) => {
              keys.set(Array.from(commitment).join(","), key);
            },
            undefined,
            undefined,
            useWorker,
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

        const attempt = async () => {
          try {
            await client.executeTransaction(faucet.id(), txRequest);
            return { succeeded: true, message: null };
          } catch (error) {
            return {
              succeeded: false,
              message: error instanceof Error ? error.message : String(error),
            };
          }
        };
        const failedAttempt = await attempt();
        const failedLookupCalls = getKeyCalls;
        const authError = useWorker ? null : client.lastAuthError();
        const authErrorMessage =
          authError instanceof Error
            ? authError.message
            : typeof authError === "string"
              ? authError
              : null;
        failLookup = false;
        const retryAttempt = await attempt();
        return {
          failedMessage: failedAttempt.message,
          retrySucceeded: retryAttempt.succeeded,
          failedLookupCalls,
          retryLookupCalls: getKeyCalls,
          authErrorMessage,
          retryAuthError: useWorker ? null : client.lastAuthError(),
        };
      }, useWorker);

      expect(failedLookupCalls).toBeGreaterThan(0);
      expect(failedMessage).toMatch(/Failed to get secret key via callback/);
      expect(failedMessage).toMatch(
        /Callback getKey-.+ timed out after 1000ms/
      );
      expect(failedMessage.match(/timed out after 1000ms/g)).toHaveLength(1);
      expect(failedMessage).not.toContain("JsValue(");
      expect(retryLookupCalls).toBeGreaterThan(failedLookupCalls);
      expect(retrySucceeded).toBe(true);
      if (!useWorker) {
        expect(authErrorMessage).toMatch(/Callback getKey-direct timed out/);
        expect(retryAuthError).toBeNull();
      }
    });
  }

  for (const useWorker of [true, false]) {
    test(`retains a failed getKey detail across later lookups (worker: ${useWorker})`, async ({
      page,
    }) => {
      const result = await page.evaluate(async (useWorker) => {
        const keys = new Map<string, Uint8Array>();
        let getKeyCalls = 0;
        let successfulLookups = 0;
        let failedLookups = 0;
        let failNextLookup = false;
        const client =
          await window.WasmWebClient.createClientWithExternalKeystore(
            window.rpcUrl,
            undefined,
            undefined,
            `${window.storeName}-multi-lookup-${useWorker}`,
            (commitment: Uint8Array) => {
              getKeyCalls++;
              if (failNextLookup) {
                failNextLookup = false;
                failedLookups++;
                return Promise.reject(
                  new Error("Callback getKey multi-lookup failure")
                );
              }
              const key = keys.get(Array.from(commitment).join(","));
              if (key) successfulLookups++;
              return Promise.resolve(key);
            },
            async (commitment: Uint8Array, key: Uint8Array) => {
              keys.set(Array.from(commitment).join(","), key);
            },
            undefined,
            undefined,
            useWorker,
            undefined,
            window.feeFaucetId
          );
        const approverKeys = Array.from({ length: 3 }, () =>
          window.AuthSecretKey.rpoFalconWithRNG()
        );
        const multisig = window.createAuthFalcon512RpoMultisig(
          new window.AuthFalcon512RpoMultisigConfig(
            approverKeys.map((key) => key.publicKey().toCommitment()),
            3
          )
        );
        const seed = new Uint8Array(32);
        crypto.getRandomValues(seed);
        const account = new window.AccountBuilder(seed)
          .storageMode(window.AccountStorageMode.private())
          .withAuthComponent(multisig)
          .withBasicWalletComponent()
          .build().account;
        const accountId = account.id();
        await client.newAccount(account, false);
        for (const key of approverKeys) {
          await client.keystore.insert(accountId, key);
        }

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
        const mintRequest = await client.newMintTransactionRequest(
          accountId,
          faucet.id(),
          window.NoteType.Private,
          BigInt(1000)
        );
        const mintTransactionId = await client.submitNewTransaction(
          faucet.id(),
          mintRequest
        );
        await client.syncState();
        const [mintRecord] = await client.getTransactions(
          window.TransactionFilter.ids([mintTransactionId])
        );
        const mintedNotes = await Promise.all(
          mintRecord
            .outputNotes()
            .notes()
            .map(async (note: any) =>
              (await client.getInputNote(note.id().toString())).toNote()
            )
        );
        const consumeRequest = await client.newConsumeTransactionRequest(
          mintedNotes,
          accountId
        );

        const callsBeforeFailure = getKeyCalls;
        const successfulBeforeFailure = successfulLookups;
        const failuresBeforeFailure = failedLookups;
        failNextLookup = true;
        let failedMessage = "transaction unexpectedly succeeded";
        try {
          await client.executeTransaction(accountId, consumeRequest);
        } catch (error) {
          failedMessage =
            error instanceof Error ? error.message : String(error);
        }
        const callsDuringFailure = getKeyCalls - callsBeforeFailure;
        const successfulLookupsAfterFailure =
          successfulLookups - successfulBeforeFailure;
        const failedLookupsDuringFailure =
          failedLookups - failuresBeforeFailure;

        let retrySucceeded = false;
        try {
          await client.executeTransaction(accountId, consumeRequest);
          retrySucceeded = true;
        } catch {
          retrySucceeded = false;
        }
        return {
          failedMessage,
          callsDuringFailure,
          successfulLookupsAfterFailure,
          failedLookupsDuringFailure,
          retrySucceeded,
        };
      }, useWorker);

      expect(result.failedLookupsDuringFailure).toBe(1);
      expect(result.callsDuringFailure).toBeGreaterThan(1);
      expect(result.successfulLookupsAfterFailure).toBeGreaterThan(0);
      expect(result.failedMessage).toContain(
        "Callback getKey multi-lookup failure"
      );
      expect(result.retrySucceeded).toBe(true);
    });
  }

  for (const useWorker of [true, false]) {
    test(`preserves sign callback errors separately from getKey (worker: ${useWorker})`, async ({
      page,
    }) => {
      const {
        message,
        signCalls,
        getKeyCalls,
        authErrorMessage,
        rawSignPreserved,
      } = await page.evaluate(async (useWorker) => {
        let signCalls = 0;
        let getKeyCalls = 0;
        const keys = new Map<string, Uint8Array>();
        const signError = Object.assign(new Error("wallet locked"), {
          reason: "locked",
        });
        const client =
          await window.WasmWebClient.createClientWithExternalKeystore(
            window.rpcUrl,
            undefined,
            undefined,
            `${window.storeName}-sign-error-${useWorker}`,
            async (commitment: Uint8Array) => {
              getKeyCalls++;
              return keys.get(Array.from(commitment).join(","));
            },
            async (commitment: Uint8Array, key: Uint8Array) => {
              keys.set(Array.from(commitment).join(","), key);
            },
            async () => {
              signCalls++;
              throw signError;
            },
            undefined,
            useWorker,
            undefined,
            window.feeFaucetId
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

        let message = "transaction unexpectedly succeeded";
        try {
          await client.executeTransaction(faucet.id(), txRequest);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        const authError = useWorker ? null : client.lastAuthError();
        return {
          message,
          signCalls,
          getKeyCalls,
          authErrorMessage:
            authError instanceof Error
              ? authError.message
              : typeof authError === "string"
                ? authError
                : null,
          rawSignPreserved: !useWorker && authError === signError,
        };
      }, useWorker);

      expect(signCalls).toBeGreaterThan(0);
      expect(getKeyCalls).toBe(0);
      expect(message).toContain("wallet locked");
      if (!useWorker) {
        expect(authErrorMessage).toBe("wallet locked");
        expect(rawSignPreserved).toBe(true);
      }
    });
  }

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
