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
```

`FaucetType.FungibleFaucet` is `0` and `FaucetType.NonFungibleFaucet` is `1`
on both runtimes. Migrate older `AccountType.*Faucet` references to
`FaucetType.*Faucet`. Neither enum has wallet or contract members: omit `type`
for a wallet, or pass `components` for a contract. Do not pass the native
visibility enum as the `type` option of `accounts.create()`.

`FaucetType.NonFungibleFaucet` is reserved: account creation currently rejects
it with "Non-fungible faucets are not supported yet". Only fungible faucet
creation is supported.

Wallets default to private storage; faucets and contracts default to public.
