// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("note screening", () => {
  test("getNoteConsumability screens a note the client has not imported", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      if (typeof client.getNoteConsumabilityForAccount !== "function") {
        return { screener: "missing" };
      }
      await client.syncState();
      const height = await client.getSyncHeight();
      const sender = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const target = await client.newWallet(
        sdk.AccountStorageMode.public(),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const faucet = await client.newFaucet(
        sdk.AccountStorageMode.public(),
        false,
        "SCR",
        "SCR",
        8,
        sdk.u64(1_000_000),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const assets = () =>
        new sdk.NoteAssets([new sdk.FungibleAsset(faucet.id(), sdk.u64(5))]);
      const view = (entries) =>
        entries.map((entry) => ({
          account: entry.accountId().toString(),
          now: entry.consumptionStatus().isConsumableNow(),
          after: entry.consumptionStatus().consumableAfterBlock() ?? null,
        }));

      const p2id = sdk.Note.createP2IDNote(
        sender.id(),
        target.id(),
        assets(),
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );
      const p2ide = sdk.Note.createP2IDENote(
        sender.id(),
        target.id(),
        assets(),
        height + 200,
        height + 100,
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );
      return {
        height,
        target: target.id().toString(),
        sender: sender.id().toString(),
        p2idForTarget: view(
          await client.getNoteConsumabilityForAccount(p2id, target.id())
        ),
        p2idForSender: view(
          await client.getNoteConsumabilityForAccount(p2id, sender.id())
        ),
        p2idForAll: view(await client.getNoteConsumability(p2id)),
        p2ideForTarget: view(
          await client.getNoteConsumabilityForAccount(p2ide, target.id())
        ),
        p2ideForSender: view(
          await client.getNoteConsumabilityForAccount(p2ide, sender.id())
        ),
        imported: (
          await client.getInputNotes(
            new sdk.NoteFilter(sdk.NoteFilterTypes.All)
          )
        ).length,
      };
    });

    expect(result.screener).toBeUndefined();
    expect(result.p2idForTarget).toEqual([
      { account: result.target, now: true, after: null },
    ]);
    // The upstream screener drops a note the account can never consume.
    expect(result.p2idForSender).toEqual([]);
    expect(result.p2idForAll).toEqual([
      { account: result.target, now: true, after: null },
    ]);
    expect(result.p2ideForTarget).toEqual([
      { account: result.target, now: false, after: result.height + 100 },
    ]);
    expect(result.p2ideForSender).toEqual([
      { account: result.sender, now: false, after: result.height + 200 },
    ]);
    expect(result.imported).toBe(0);
  });
});
