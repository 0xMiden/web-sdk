// @ts-nocheck
import { test, expect } from "./test-setup";

// PROTOCOL CONFIG
// =======================================================================================================
//
// `client.protocolConfig()` exposes the configuration the connected network's blocks commit to, so a
// dApp can read the fee asset without a hardcoded table. See issue #570.

test.describe("protocolConfig", () => {
  test("reports the fee faucet and the commitment the block header carries", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();
      const request = await client.newMintTransactionRequest(
        wallet.id(),
        faucet.id(),
        sdk.NoteType.Private,
        BigInt(5)
      );
      const header = (
        await client.chainAnchorForRequest(request)
      ).blockHeader();

      const config = await client.protocolConfig();
      return {
        isConfig: config instanceof sdk.ProtocolConfig,
        configFaucet: config.feeFaucetId().toString(),
        clientFaucet: (await client.feeFaucetId()).toString(),
        commitment: config.commitment().toHex(),
        headerCommitment: header.protocolConfigCommitment().toHex(),
      };
    });

    expect(result.isConfig).toBe(true);
    expect(result.configFaucet).toBe(result.clientFaucet);
    expect(result.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.commitment).not.toMatch(/^0x0+$/);
    expect(result.commitment).toBe(result.headerCommitment);
  });

  test("reads protocol configurations preserved from the legacy store", async ({
    run,
  }) => {
    const result = await run(async ({ client, helpers }) => {
      await helpers.setupWalletAndFaucet();
      const original = await client.protocolConfig();
      const commitment = original.commitment().toHex();
      const nativeClient = await client.getWasmWebClient();
      const legacy = await nativeClient.serializeLegacyMockProtocolConfig();
      const storeName = await client.storeIdentifier();

      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(storeName);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("clientConfig", "readwrite");
          const store = tx.objectStore("clientConfig");
          const key = `protocol_config:${commitment}`;
          const row = store.get(key);
          row.onsuccess = () => {
            if (!row.result) {
              tx.abort();
              return;
            }
            store.put({ key, value: legacy });
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => {
            db.close();
            reject(
              tx.error ?? new Error(`Missing protocol configuration ${key}`)
            );
          };
        };
      });

      const restored = await client.protocolConfig();
      return {
        originalFaucet: original.feeFaucetId().toString(),
        restoredFaucet: restored.feeFaucetId().toString(),
        commitment,
        restoredCommitment: restored.commitment().toHex(),
      };
    });

    expect(result.restoredFaucet).toBe(result.originalFaucet);
    expect(result.restoredCommitment).toBe(result.commitment);
  });
});
