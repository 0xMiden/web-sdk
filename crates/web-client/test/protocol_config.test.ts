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
      const header = (await client.executeTransaction(faucet.id(), request))
        .executedTransaction()
        .blockHeader();

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
});
