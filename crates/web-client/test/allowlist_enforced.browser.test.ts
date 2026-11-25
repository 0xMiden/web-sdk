import { createHash, randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { getProverUrl, getRpcUrl, test } from "./playwright.global.setup";

const adminUrl = "http://127.0.0.1:50100";
const fundingUrl = "http://127.0.0.1:50401";

test.beforeAll(() => {
  expect(new URL(getRpcUrl()).origin).toMatch(
    /^http:\/\/(localhost|127\.0\.0\.1):57291$/
  );
  expect(getProverUrl()).toBeUndefined();
});

test("registers a private wallet with a node-issued invitation", async ({
  page,
  request,
}) => {
  const invitation = randomUUID();
  const digest = createHash("sha256").update(invitation).digest("hex");
  const issued = await request.put(
    `${adminUrl}/admin/allowlist/invitations/${digest}`,
    {
      data: { ["account_id"]: null },
      maxRedirects: 0,
    }
  );
  expect(issued.ok()).toBe(true);

  const result = await page.evaluate(
    async ({ invitation, unknown }) => {
      const { client } = window;
      const wallet = await client.newWallet(
        window.AccountStorageMode.private(),
        "falcon"
      );
      const id = wallet.id();
      const allowedBefore = await client.isAccountAllowed(id);
      const acceptsUnknown = await client.isInvitationCodeValid(unknown);
      const acceptsInvitation = await client.isInvitationCodeValid(invitation);
      let unknownError;
      try {
        await client.registerAccount(id, unknown);
      } catch (error) {
        unknownError = (error as { code?: string }).code;
      }
      await client.registerAccount(id, invitation);
      return {
        allowedBefore,
        acceptsUnknown,
        unknownError,
        acceptsInvitation,
        allowedAfter: await client.isAccountAllowed(id),
        acceptsUsedCode: await client.isInvitationCodeValid(invitation),
      };
    },
    { invitation, unknown: randomUUID() }
  );

  expect(result).toEqual({
    allowedBefore: false,
    acceptsUnknown: false,
    unknownError: "INVITATION_NOT_FOUND",
    acceptsInvitation: true,
    allowedAfter: true,
    acceptsUsedCode: false,
  });
});

test("rejects an unregistered wallet's first transaction", async ({
  page,
  request,
}) => {
  const accountId = await page.evaluate(async () => {
    const wallet = await window.client.newWallet(
      window.AccountStorageMode.private(),
      "falcon"
    );
    return wallet.id().toString();
  });

  // Execution precedes the allowlist check, so the wallet needs a test fee note.
  const funded = await request.post(`${fundingUrl}/request-funds`, {
    data: { ["account_id"]: accountId, amount: 10_000_000 },
    maxRedirects: 0,
  });
  expect(funded.ok()).toBe(true);

  await expect
    .poll(
      async () => {
        return page.evaluate(async (accountId) => {
          const { client, AccountId } = window;
          await client.syncState();
          return (await client.getConsumableNotes(AccountId.fromHex(accountId)))
            .length;
        }, accountId);
      },
      { timeout: 60_000 }
    )
    .toBeGreaterThan(0);

  const rejection = await page.evaluate(async (accountId) => {
    const { client, AccountId } = window;
    const records = await client.getConsumableNotes(
      AccountId.fromHex(accountId)
    );
    const notes = records.map((record) => record.inputNoteRecord().toNote());
    // getConsumableNotes consumes its AccountId handle.
    const id = AccountId.fromHex(accountId);
    const deploy = await client.newConsumeTransactionRequest(notes, id);
    try {
      await client.submitNewTransaction(id, deploy);
      return null;
    } catch (error) {
      return {
        code: (error as { code?: string }).code,
        message: String(error),
      };
    }
  }, accountId);

  expect(rejection?.code, rejection?.message).toBe("ACCOUNT_NOT_ALLOWLISTED");
});
