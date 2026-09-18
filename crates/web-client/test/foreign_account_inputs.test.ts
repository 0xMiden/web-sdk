// @ts-nocheck
import { test, expect } from "./test-setup";

test("foreign account inputs preserve descending account order, including prefetched entries", async ({
  run,
}) => {
  const result = await run(async ({ client, sdk, helpers }) => {
    const { wallet, faucet } = await helpers.setupWalletAndFaucet();
    await helpers.mockMintAndConsume(wallet.id(), faucet.id());
    const accounts = [
      await client.getAccount(wallet.id()),
      await client.getAccount(faucet.id()),
    ].sort((a, b) => b.id().toString().localeCompare(a.id().toString()));
    const foreignAccounts = accounts.map((account) =>
      sdk.ForeignAccount.private(account)
    );
    const fetchInputs = async (entries) => {
      const array = new sdk.ForeignAccountArray();
      for (const entry of entries) array.push(entry);
      const inputs = await client.getForeignAccountInputs(
        array,
        await client.getSyncHeight()
      );
      return Array.isArray(inputs)
        ? inputs
        : Array.from({ length: inputs.length() }, (_, i) => inputs.get(i));
    };
    const inputs = await fetchInputs(foreignAccounts);
    const prefetched = inputs.map((input) =>
      sdk.ForeignAccount.prefetched(
        sdk.AccountInputs.deserialize(input.serialize())
      )
    );
    // Repeat an entry to catch deduplication as well as sorting by account ID.
    const repeated = await fetchInputs([
      prefetched[0],
      foreignAccounts[1],
      prefetched[0],
    ]);
    return {
      expected: accounts.map((account) => account.id().toString()),
      // `accountId` is the one spelling on both builds. Accepting a
      // snake_case fallback here is what let the WASM and Node surfaces
      // drift apart unnoticed, so the assertion pins the camelCase name.
      callerIds: foreignAccounts.map((account) =>
        account.accountId().toString()
      ),
      fetched: inputs.map((input) => input.accountId().toString()),
      repeated: repeated.map((input) => input.accountId().toString()),
    };
  });
  expect(result.fetched).toEqual(result.expected);
  expect(result.callerIds).toEqual(result.expected);
  expect(result.repeated).toEqual([
    result.expected[0],
    result.expected[1],
    result.expected[0],
  ]);
});
