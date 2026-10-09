---
title: Read and send non-fungible assets
---

# Read and send non-fungible assets

## Create a faucet, mint, send and swap

```typescript
import { FaucetType, NonFungibleAsset, Word } from "@miden-sdk/miden-sdk";

const collection = await client.accounts.create({
  type: FaucetType.NonFungibleFaucet,
  name: "Collectible",
  symbol: "NFT",
});

// The first two value elements are the token ID the faucet records as issued.
const value = new Word(new BigUint64Array([1n, 2n, 3n, 4n]));
const nft = new NonFungibleAsset(collection.id(), value);

await client.transactions.mint({ account: collection, to: alice, asset: nft });
// After Alice consumes the P2ID note:
await client.transactions.send({ account: alice, to: bob, asset: nft });
await client.transactions.swap({
  account: bob,
  offer: nft,
  request: { token: tokenFaucet, amount: 100n },
});
```

A non-fungible faucet takes `symbol` and an optional `name`; it has no
`decimals` or `maxSupply`, and passing either throws. `Account.isFaucet()` is
true for it. `mint` with `asset` requires that `account` is the faucet that
issued the asset. A faucet issues each token ID once; minting the same token ID
again fails. `send` with `asset` takes the same `type`, `reclaimAfter`,
`timelockUntil` and `returnNote` options as a fungible send. `swap` accepts a
`NonFungibleAsset` for `offer`, `request`, or both, and `createNetworkNote`
accepts one in `assets`. Batch `send` and `mint` operations and `preview()`
take the same `asset` form. Bridge and PSWAP remain fungible-only.

## Read owned assets

Read owned non-fungible assets after you restore and import an account with
its complete vault. Local registration history is not required.

```typescript
await client.sync();
const { vault } = await client.accounts.getDetails(wallet);
const assets = vault.nonFungibleAssets().map((asset) => ({
  issuer: asset.faucetId().toString(),
  key: asset.vaultKey().toHex(),
  value: Array.from(asset.intoWord().toU64s()),
}));
```

`nonFungibleAssets()` returns only non-fungible assets from the local vault
snapshot. It returns an empty array when none are present. The order is not
specified. `faucetId()` identifies the issuer, `vaultKey()` returns the complete
asset key, and `intoWord().toU64s()` returns all four value limbs as `bigint`
values. Keep these values as `bigint` or strings to prevent precision loss.

Compare both the complete key and all four value limbs to verify an asset.
The key alone does not contain the complete value. To reconstruct an asset,
use `VaultAsset.nonFungible({ key, value })` with the two `Word` objects.
`VaultAsset.fromVaultEntry(key, value)` can reconstruct either asset variant.

For name recovery, use the issuer and asset key with the name faucet's
`token_to_domain` map. That map's schema defines how to read the label; the
SDK does not decode it. Verify the recovered label against the complete asset.
Enumeration does not publish name-to-address registry records.

## Build a note with assets

```typescript
import { VaultAsset, NoteAssets } from "@miden-sdk/miden-sdk";

const token = VaultAsset.fungible(faucetId, 100n);
const name = VaultAsset.nonFungible({ key, value });
const nameAssets = new NoteAssets([name]);
const mixedAssets = new NoteAssets([token]);
mixedAssets.push(name);
```

`NoteAssets` accepts 0 to 16 assets in one list. A note can contain one
fungible asset, one non-fungible asset, or a mix. Existing `FungibleAsset`
values still work in the constructor and `push()`. `NonFungibleAsset` values
also work. Inputs remain usable after either call. Invalid entries, duplicate
asset IDs, and lists longer than 16 assets throw catchable errors. A failed
`push()` leaves the list unchanged.

Use `vault.assets()` or `note.assets().assets()` to read both variants as
`VaultAsset` values. `kind()` returns `"fungible"` or `"nonFungible"`.
`asFungible()` and `asNonFungible()` return a copy of the selected variant,
and throw if the variant does not match. The existing filtered getters remain
available. Note asset order is preserved; vault asset order is unspecified.

## Publish a registry record

Ownership alone does not publish a name. Build the registry's approved note
recipient with its required script and inputs, and send a public note with
the name NFA as its single asset:

```typescript
import { NetworkAccountTarget, Note, NoteAssets, NoteMetadata, NoteTag, NoteType } from "@miden-sdk/miden-sdk";

// registryRecipient contains the registry's approved script and required inputs.
const note = Note.withAttachments(
  new NoteAssets([name]),
  new NoteMetadata(ownerId, NoteType.Public, NoteTag.withAccountTarget(registryId)),
  registryRecipient,
  [new NetworkAccountTarget(registryId).toAttachment()],
);
```

The registry account must be public. The `NetworkAccountTarget` attachment
makes this a network note; the tag alone does not. The target account must
allow the note script.

Use this note with `TransactionRequestBuilder.withOwnOutputNotes()` and the
custom transaction flow in [Transactions](./transactions.md). The SDK does
not supply or validate a registry-specific script or its allowlist. Use the
contract's current script and input schema. For a plain transfer without a
registry script, use `client.transactions.send({ account, to, asset })`.

When the registry returns the NFA in a P2ID note, consume that note through
the normal note-consumption flow. The asset then appears in the owner's
vault through `assets()` and `nonFungibleAssets()`.

See [Transactions](./transactions.md) for transaction operations.
