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

`FaucetType.FungibleFaucet` is the string `"FungibleFaucet"` on both runtimes,
so it cannot be mistaken for an `AccountType` value. Migrate older
`AccountType.FungibleFaucet` references to `FaucetType.FungibleFaucet`. Neither
enum has wallet or contract members: omit `type` for a wallet, or pass
`components` for a contract. `accounts.create()` throws a `TypeError` for any
other `type`, including a native visibility value, and for faucet fields
(`name`, `symbol`, `decimals`, `maxSupply`) without a faucet selector.
Non-fungible faucets are not supported yet.

Wallets default to private storage; faucets and contracts default to public.
