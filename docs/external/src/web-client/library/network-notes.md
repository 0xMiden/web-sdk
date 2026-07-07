---
title: Network Notes
sidebar_position: 20
---

# Network Notes

A network note is a Public note carrying a `NetworkAccountTarget` attachment.
Once it lands on-chain, the targeted network account auto-consumes it — there's
no manual `consume` call on the recipient side. Build and submit one with a
custom consumption script:

```typescript
import { MidenClient } from "@miden-sdk/miden-sdk";

const client = await MidenClient.create();

const req = await client.transactions.createNetworkNote({
  account: senderId,
  target: networkAccountId,
  script: myNoteScript, // or: recipient: myRecipient
  waitForConfirmation: true,
});

console.log(req.note.isNetworkNote()); // true
```

`createNetworkNote` builds the note (`Note.withAttachments` plus a
`NetworkAccountTarget` attachment), submits it as an own output note, and
returns `{ txId, note, result }`. Provide exactly one of `script` or
`recipient` — passing both, or neither, throws. Notes are always Public — the
attachment, not the tag, is what a network account matches on.

## Targeting a network account

`target` accepts an account reference (hex/bech32 id or `AccountId`), or a
pre-built `NetworkAccountTarget` when you need control over the execution
hint:

```typescript
import { NetworkAccountTarget, NoteExecutionHint } from "@miden-sdk/miden-sdk";

const target = new NetworkAccountTarget(
  networkAccountId,
  NoteExecutionHint.always()
);

await client.transactions.createNetworkNote({
  account: senderId,
  target,
  recipient: myRecipient,
});
```

On the plain-reference form, `executionHint` defaults to `always`.

## Assets and extra attachments

`assets` locks one or more assets into the note; omit it for a zero-asset
note. `attachment` appends an extra payload after the required
`NetworkAccountTarget` — read every attachment back with `note.attachments()`:

```typescript
const { note } = await client.transactions.createNetworkNote({
  account: senderId,
  target: networkAccountId,
  script: myNoteScript,
  assets: [{ token: dagToken, amount: 100n }],
  attachment: [1n, 2n, 3n],
});

note.attachments(); // [NetworkAccountTarget attachment, extra payload]
```

## Building without submitting

The standalone `buildNetworkNote(opts)` builds the same `Note` without
submitting — useful when you need to inspect, batch, or otherwise hold onto
the note before sending it via `client.transactions.submit(...)` or
`client.transactions.batch(...)`:

```typescript
import { buildNetworkNote } from "@miden-sdk/miden-sdk";

const note = buildNetworkNote({
  account: senderId,
  target: networkAccountId,
  script: myNoteScript,
});
```

## See also

- [Transactions](./transactions.md) — general transaction submission and batching.
