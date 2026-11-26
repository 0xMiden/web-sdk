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

## Querying and paging notes

`notes.list` and `notes.listSent` take a `status`, `ids`, `scriptRoots` or
`nullifiers` filter. `limit` and `after` bound the result to one page, in
ascending key order and strictly above `after`. Input notes are keyed by
`record.detailsCommitment().toHex()`, output notes by `record.id().toString()`.
The store still reads every match, so a page bounds what reaches JavaScript,
not the read.

```typescript
const page = await client.notes.list({ status: "committed", limit: 50 });
const last = page.at(-1);
const next = last
  ? await client.notes.list({
      status: "committed",
      limit: 50,
      after: last.detailsCommitment().toHex(),
    })
  : [];

// A partial note has no nullifier yet, so skip those.
const nullifiers = page.map((note) => note.nullifier()).filter(Boolean);
const spent = await client.notes.list({ nullifiers });
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

## Decoding standard notes

`P2idNote`, `P2ideNote` and `SwapNote` decode a standard note into its typed
fields, so an inbox can show who a note pays, when it unlocks and what a swap
exchanges without reading raw storage:

```typescript
import { NoteScript, P2idNote, P2ideNote, SwapNote } from "@miden-sdk/miden-sdk";

const note = record.toNote();
const root = note.script().root().toHex();

if (root === NoteScript.p2id().root().toHex()) {
  const p2id = P2idNote.tryFromNote(note);
  p2id.target(); // who it pays
  p2id.assets();
} else if (root === NoteScript.p2ide().root().toHex()) {
  const p2ide = P2ideNote.tryFromNote(note);
  p2ide.target();
  p2ide.timelockHeight(); // number | undefined: not consumable before this block
  p2ide.reclaimer();
  p2ide.reclaimHeight(); // number | undefined: the reclaimer may take it back from here
} else if (root === NoteScript.swap().root().toHex()) {
  const swap = SwapNote.tryFromNote(note);
  swap.offeredAsset(); // what the consumer receives
  swap.requestedAsset(); // what the consumer pays back to swap.sender()
  swap.paybackNoteType();
  swap.paybackTarget(); // AccountId | undefined (public payback only)
  swap.paybackRecipient(); // Word | undefined (private payback only)
}
```

Each decoder also exposes `sender()`, `serialNumber()`, `noteType()` and
`intoNote()`. `tryFromNote` throws when the note runs another script
(`not a P2ID note`), when its storage does not decode, or, for `SwapNote`, when
it does not carry exactly one asset.

`PswapNote` and `BurnNote` decode a partial-fill swap order and a burn the same
way:

```typescript
import { BurnNote, NoteScript, PswapNote } from "@miden-sdk/miden-sdk";

if (root === NoteScript.pswap().root().toHex()) {
  const pswap = PswapNote.tryFromNote(note);
  pswap.offeredAsset(); // FungibleAsset on offer
  pswap.requestedAsset(); // FungibleAsset asked for the whole offer
  pswap.minFillStep(); // smallest fill, 0 when unbounded
  pswap.creatorAccountId(); // receives every payback
  pswap.orderId(); // decimal string, as PswapLineageRecord.orderId()
  pswap.parentDepth(); // 0 for the original order, +1 per remainder
} else if (root === NoteScript.burn().root().toHex()) {
  const burn = BurnNote.tryFromNote(note);
  burn.asset(); // what the faucet burns
  burn.faucetId(); // the faucet that consumes the note
}
```

A BURN note whose storage does not hold exactly the asset it carries is
rejected, as the BURN script rejects it at consume time. A PSWAP note with more than one
attachment is rejected too.

`MintNote` decodes a MINT note, which asks a network faucet to mint an asset
into a new note:

```typescript
import { MintNote, NoteScript } from "@miden-sdk/miden-sdk";

if (root === NoteScript.mint().root().toHex()) {
  const mint = MintNote.tryFromNote(note);
  mint.asset(); // what the faucet mints
  mint.faucetId(); // the faucet that consumes the note
  mint.tag(); // tag of the minted note
  mint.recipientDigest(); // private minted note: its recipient, else undefined
  mint.recipientScriptRoot(); // public minted note: its script root,
  mint.recipientSerialNumber(); // serial number
  mint.recipientStorage(); // and storage, else undefined
}
```

To screen a note before importing it, pass it to `client.notes.screen`. Each
entry is a `NoteConsumability`, as `ConsumableNoteRecord.noteConsumability()`
lists them:

```typescript
const all = await client.notes.screen(note); // every tracked account
const mine = await client.notes.screen(note, { account: wallet });
for (const entry of mine) {
  const status = entry.consumptionStatus();
  status.isConsumableNow(); // consumable at the last synced block
  status.consumableAfterBlock(); // unlock height when locked, else undefined
}
```

The screener leaves out accounts that can never consume the note, and accounts
that cannot consume it under the current conditions, so an empty array means
no screened account can consume it now. It is also empty when the client
tracks no accounts, so do not read it as never consumable. Screening does
not import the note. The low-level `WebClient` exposes the same screen as
`getNoteConsumability(note)` and `getNoteConsumabilityForAccount(note, accountId)`.

In `@miden-sdk/react`, `useNoteConsumability(note, { accountId? })` runs this
screen, again after each sync, and reduces it to a `status` of
`{ kind: "immediately" }`, `{ kind: "afterBlock", blockHeight }` or
`{ kind: "never" }`. An empty screen of tracked accounts is `never`; when the
client tracks no accounts, `status` stays `null`. It only presents the result: `useNotes().consumableNotes`
still offers payments consumable now and nothing else.

See also [Transactions](./transactions.md) for `consumeAll`'s fee handling.
