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
`components` for a contract, and choose visibility with `storage` only.
A contract also needs a raw 32-byte `seed` and `auth`. `auth` is an
`AuthSecretKey` stored with the account, or `"none"` for a NoAuth contract that
anyone can call and that stores no key. Omitting `auth` is rejected and does
not default to NoAuth. `"none"` is only valid on a contract; wallet and faucet
`auth` stays `AuthScheme.Falcon` or `AuthScheme.ECDSA`.

A component, transaction script or note script can also come from a compiled
package (`.masp`) instead of MASM source: pass `package` (a `Package` or its
serialized bytes) in place of `code`, for example
`client.compile.component({ package: bytes, slots })`, then pass the result to
`accounts.create({ components })` as usual. `compile.txScript` and
`compile.noteScript` take `{ package }` the same way. `namespace` and
`libraries` apply to source only, and a package must be the right kind for what
you build. A component built from a package always gets the fixed metadata name
`"custom"`, whatever name the package declares, and `supportAllTypes` still
defaults to `true`. The `Package` you pass stays usable afterward.

`accounts.create()` still reads the legacy selectors `0`, `1` and
`"NonFungibleFaucet"` as faucet types (`0` fungible; the non-fungible ones are
rejected, since non-fungible faucets are not supported yet). `0` and `1` are
also the values of `AccountType.Private` and `AccountType.Public`, so never pass
a visibility value as `type`: it is read as a legacy faucet selector. It throws
a `TypeError` for any other `type`, for faucet fields (`name`, `symbol`,
`decimals`, `maxSupply`) without a faucet type, for `components` on a faucet,
and for a faucet missing `symbol`, `decimals` or `maxSupply`.

`client.contracts.deploy({ components, seed?, auth?, storage? })` is
`accounts.create` for a contract with the missing inputs filled in: a random
32-byte `seed` and a freshly generated Falcon `AuthSecretKey` (stored with the
account) when you omit them, and `"public"` storage unless you pass `storage`.
It resolves to `{ account, seed, auth }`, the values it used, and shares
`accounts.create`'s validation. It throws a `TypeError` without `components`
rather than creating a wallet.

Wallets default to private storage; faucets and contracts default to public.
