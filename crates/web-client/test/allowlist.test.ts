// @ts-nocheck
import { test, expect } from "./test-setup";

// Neither the mock chain nor the CI test node enforces an account allowlist, so
// the node allows every account and the client refuses to spend an invitation
// code on one. The enforcing path (a code the node accepts, funding, the
// `ACCOUNT_NOT_ALLOWLISTED` rejection) needs a node started with
// MIDEN_ACCOUNT_ALLOWLIST=1 and an invitation code from its admin API.
test.describe("account allowlist", () => {
  test("isAccountAllowed answers true when the node enforces no allowlist", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const wallet = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      return { allowed: await client.isAccountAllowed(wallet.id()) };
    });
    expect(result.allowed).toBe(true);
  });

  test("isInvitationCodeValid answers true when the node enforces no allowlist", async ({
    run,
  }) => {
    const result = await run(async ({ client }) => {
      return { valid: await client.isInvitationCodeValid("invitation-code") };
    });
    expect(result.valid).toBe(true);
  });

  // Sent to the CI test node rather than the mock chain, so a node without the
  // `IsInvitationCodeValid` endpoint (anything before 0.17.3) fails it.
  test("isInvitationCodeValid reaches the test node through the client and RpcClient", async ({
    run,
  }) => {
    const result = await run(async ({ sdk, helpers }) => {
      const integration = await helpers.createIntegrationClient();
      if (!integration) return { skip: true };
      const rpcClient = new sdk.RpcClient(
        new sdk.Endpoint(helpers.getRpcUrl())
      );
      return {
        skip: false,
        viaClient:
          await integration.client.isInvitationCodeValid("invitation-code"),
        viaRpc: await rpcClient.isInvitationCodeValid("invitation-code"),
      };
    });
    if (result.skip) {
      test.skip(true, "requires running node");
      return;
    }
    expect(result.viaClient).toBe(true);
    expect(result.viaRpc).toBe(true);
  });

  test("registerAccount keeps the code for an account the node already allows", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const wallet = await client.newWallet(
        sdk.AccountStorageMode.private(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      try {
        await client.registerAccount(wallet.id(), "invitation-code");
        return { threw: false };
      } catch (error) {
        return {
          threw: true,
          code: error.code ?? null,
          message: String(error.message ?? error),
        };
      }
    });
    expect(result.threw).toBe(true);
    // The WASM build attaches the code; the Node binding only carries the message.
    expect(
      result.code === "ACCOUNT_ALREADY_ALLOWED" ||
        result.message.includes("already allowed")
    ).toBe(true);
  });

  test("registerAccount rejects an account the client does not track", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const untracked = sdk.AccountId.fromHex(
        "0x69817bcc6fb9f99127c2245f6979c5"
      );
      try {
        await client.registerAccount(untracked, "invitation-code");
        return { threw: false };
      } catch (error) {
        return { threw: true, message: String(error.message ?? error) };
      }
    });
    expect(result.threw).toBe(true);
    expect(result.message).toContain("failed to register account");
  });
});
