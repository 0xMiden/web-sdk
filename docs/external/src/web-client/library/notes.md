---
title: Consumable Notes
sidebar_position: 30
---

# Consumable Notes

A note your account can consume is not always a note it should consume, or can
consume yet. The client's note screener lists every note a trial consume
succeeds for, with a per-account consumption status:

- A P2IDE note can carry a timelock, so the chain rejects it until a given
  block. The screener reports it as consumable after that block.
- A note running any script other than P2ID or P2IDE can spend from the
  consuming account. Anyone holding the asset a public PSWAP order requests
  can consume it, so the screener lists another trader's order for your
  account, and consuming it fills the order from your vault at their price.

The SDK splits the readings:

- `notes.listAvailable({ account })` returns only the payments (P2ID and P2IDE
  notes) the account can consume at the client's last synced block.
- `notes.listConsumable({ account? })` returns every note the screener lists,
  including block-locked ones and other scripts, with their consumability
  metadata.
- `transactions.consumeAll({ account })` consumes the first set. A block-locked
  note would fail the whole transaction, and another script is consumed only
  when you name it, so both are skipped and count towards neither `consumed`
  nor `remaining`.

Both listings reflect the last sync, so sync first for a current answer.

```typescript
import { MidenClient } from "@miden-sdk/miden-sdk";

const client = await MidenClient.create();
await client.sync();

const ready = await client.notes.listAvailable({ account: wallet });
const result = await client.transactions.consumeAll({ account: wallet });
// `remaining === 0` means no payment is consumable now, not that the account
// has no unconsumed notes.
```

To consume a note running another script, such as a PSWAP order you mean to
fill, pass it by name to `transactions.consume({ account, notes })` or use
`transactions.pswapConsume`.

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
import { isConsumableNow, isStandardPayment } from "@miden-sdk/miden-sdk";

const ready = records.filter(
  (record) => isConsumableNow(record, walletId) && isStandardPayment(record)
);
```

`isStandardPayment` reads the note's script, so it needs the SDK's WASM: with a
lazy entry, await `MidenClient.ready()` first.

`@miden-sdk/react` already does this: `useNotes().consumableNotes`,
`useWaitForNotes()` and `useSessionAccount`'s funding poll all report and act on
payments that are consumable now.

See also [Transactions](./transactions.md) for `consumeAll`'s fee handling.
