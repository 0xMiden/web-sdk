---
title: Consumable Notes
sidebar_position: 30
---

# Consumable Notes

A note your account owns is not always a note you can spend. A P2IDE note can
carry a timelock, so the chain rejects it until a given block. The client's note
screener reports that as a per-account consumption status, and the SDK splits
the two readings:

- `notes.listAvailable({ account })` returns only what the account can consume
  at the client's last synced block.
- `notes.listConsumable({ account? })` returns those plus the block-locked ones,
  with their consumability metadata.
- `transactions.consumeAll({ account })` consumes the first set. A block-locked
  note would fail the whole transaction, so it is skipped, and it counts towards
  neither `consumed` nor `remaining`.

Both listings reflect the last sync, so sync first for a current answer.

```typescript
import { MidenClient } from "@miden-sdk/miden-sdk";

const client = await MidenClient.create();
await client.sync();

const ready = await client.notes.listAvailable({ account: wallet });
const result = await client.transactions.consumeAll({ account: wallet });
// `remaining === 0` means nothing is consumable now, not that the account has
// no unconsumed notes.
```

## Reading why a note is not ready

`listConsumable` keeps each record's `noteConsumability()`, which holds one
status per account. Match the entry to the account you asked about rather than
taking the first, and read the status rather than inferring it from a missing
block number: a note that can never be consumed also reports no block.

```typescript
const walletId = wallet.id().toString();

for (const record of await client.notes.listConsumable({ account: wallet })) {
  const entry = record
    .noteConsumability()
    .find((nc) => nc.accountId().toString() === walletId);
  const status = entry?.consumptionStatus();

  if (status && !status.isConsumableNow()) {
    console.log(`unlocks at block ${status.consumableAfterBlock()}`);
  }
}
```

Omit `account` to list notes consumable by any account the client tracks; every
entry then belongs to the account named on it.

## Applying the same rule elsewhere

Code that reads the low-level client directly can apply the SDK's own rule
instead of restating it:

```typescript
import { isConsumableNow } from "@miden-sdk/miden-sdk";

const ready = records.filter((record) => isConsumableNow(record, walletId));
```

`@miden-sdk/react` already does this: `useNotes().consumableNotes`,
`useWaitForNotes()` and `useSessionAccount`'s funding poll all report and act on
notes that are consumable now.

See also [Transactions](./transactions.md) for `consumeAll`'s fee handling.
