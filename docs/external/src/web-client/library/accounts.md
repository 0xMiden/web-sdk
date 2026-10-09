# Account Visibility and Faucet Types

Use `AccountType.Private` and `AccountType.Public` with the low-level
`AccountBuilder.accountType()` method. The native visibility enum is exported
in both browser and Node.js:

```typescript
import { AccountBuilder, AccountType } from "@miden-sdk/miden-sdk";

const builder = new AccountBuilder(new Uint8Array(32))
  .accountType(AccountType.Public);
```

The high-level resource API selects visibility through `storage` and faucet
kind through `FaucetType`:

```typescript
import { MidenClient, FaucetType } from "@miden-sdk/miden-sdk";

const client = await MidenClient.createDevnet();
const wallet = await client.accounts.create({ storage: "private" });
const faucet = await client.accounts.create({
  type: FaucetType.FungibleFaucet,
  storage: "public",
  symbol: "TOK",
  decimals: 8,
  maxSupply: 10_000_000n,
});
const collection = await client.accounts.create({
  type: FaucetType.NonFungibleFaucet,
  symbol: "NFT",
});
```

`FaucetType.FungibleFaucet` is the string `"FungibleFaucet"` on both runtimes,
so it cannot be mistaken for an `AccountType` value. Migrate older
`AccountType.FungibleFaucet` references to `FaucetType.FungibleFaucet`. Neither
enum has wallet or contract members: omit `type` for a wallet, or pass
`components` for a contract, and choose visibility with `storage` only.

`FaucetType.NonFungibleFaucet` is the string `"NonFungibleFaucet"`. A
non-fungible faucet takes `symbol` and an optional `name`, and no `decimals` or
`maxSupply`. See [non-fungible assets](./non-fungible-assets.md) to mint and
transfer its assets.

`accounts.create()` still reads the legacy selectors `0` (fungible) and `1`
(non-fungible) as faucet types. They are also the values of
`AccountType.Private` and `AccountType.Public`, so never pass a visibility value
as `type`: it is read as a legacy faucet selector. It throws a `TypeError` for
any other `type`, for faucet fields (`name`, `symbol`, `decimals`, `maxSupply`)
without a faucet type, for `components` on a faucet, for a fungible faucet
missing `symbol`, `decimals` or `maxSupply`, for a non-fungible faucet missing
`symbol`, and for a non-fungible faucet given `decimals` or `maxSupply`.

Wallets default to private storage; faucets and contracts default to public.
