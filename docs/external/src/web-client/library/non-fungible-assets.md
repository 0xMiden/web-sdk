---
title: Read and send non-fungible assets
---

# Read and send non-fungible assets

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
use `Asset.nonFungible({ key, value })` with the two `Word` objects.
`Asset.fromVaultEntry(key, value)` can reconstruct either asset variant.

For name recovery, use the issuer and asset key with the name faucet's
`token_to_domain` map. That map's schema defines how to read the label; the
SDK does not decode it. Verify the recovered label against the complete asset.
Enumeration does not publish name-to-address registry records.

## Build a note with assets

```typescript
import { Asset, NoteAssets } from "@miden-sdk/miden-sdk";

const token = Asset.fungible(faucetId, 100n);
const name = Asset.nonFungible({ key, value });
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
`Asset` values. `kind()` returns `"fungible"` or `"nonFungible"`.
`asFungible()` and `asNonFungible()` return a copy of the selected variant,
and throw if the variant does not match. The existing filtered getters remain
available. Note asset order is preserved; vault asset order is unspecified.

## Publish a registry record

Ownership alone does not publish a name. Build the registry's approved note
recipient with its required script and inputs, and send a public note with
the name NFA as its single asset:

```typescript
import { Note, NoteAssets, NoteMetadata, NoteTag, NoteType } from "@miden-sdk/miden-sdk";

// registryRecipient contains the registry's approved script and required inputs.
const note = new Note(
  new NoteAssets([name]),
  new NoteMetadata(ownerId, NoteType.Public, NoteTag.withAccountTarget(registryId)),
  registryRecipient,
);
```

Use this note with `TransactionRequestBuilder.withOwnOutputNotes()` and the
custom transaction flow in [Transactions](./transactions.md). The SDK does
not supply or validate a registry-specific script or its allowlist. Use the
contract's current script and input schema. The amount-based `send` helper
remains a fungible-token API.

When the registry returns the NFA in a P2ID note, consume that note through
the normal note-consumption flow. The asset then appears in the owner's
vault through `assets()` and `nonFungibleAssets()`.

See [Transactions](./transactions.md) for transaction operations.
