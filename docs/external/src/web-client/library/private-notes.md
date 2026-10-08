---
title: Private Note Delivery
sidebar_position: 50
---

# Private Note Delivery

A private note lives on-chain only as a commitment. Its recipient learns of it
when the sender relays the note details through the note transport, together
with the note's inclusion proof, which exists once the creating transaction has
committed and the sender has synced past it.

```typescript
import { MidenClient, NoteVisibility } from "@miden-sdk/miden-sdk";

const client = await MidenClient.createTestnet();

const { txId, note } = await client.transactions.send({
  account: wallet,
  to: recipient,
  token: faucet,
  amount: 100n,
  type: NoteVisibility.Private,
  returnNote: true,
  waitForConfirmation: true,
});

// The transaction has committed; relay the note to its recipient.
const noteId = note.id();
await client.notes.sendPrivateOutput({ noteId, to: recipient });
```

`notes.sendPrivateOutput({ noteId, to })` relays one of this client's own output
notes and reads the proof sync stored on it. `notes.sendPrivate({ note, to,
inclusionProof })` relays any note with a proof you supply.

## A rejected send is final

The client keeps no queue. If a send rejects, the note did not reach the
transport or the outcome is not known, and neither `sync()` nor
`syncNoteTransport()` sends it again. To try again, call the same method with
the same note: the transport stores a note once and the recipient imports it
once, so a repeat cannot duplicate it.

```typescript
try {
  await client.notes.sendPrivateOutput({ noteId, to: recipient });
} catch (err) {
  // Keep `noteId` and the recipient; nothing will retry this for you.
  await client.sync();
  await client.notes.sendPrivateOutput({ noteId, to: recipient });
}
```

## Transport retries within a send

Before a send rejects, it retries a transient transport failure itself: a
failed connection, `Unavailable`, `DeadlineExceeded`, or `ResourceExhausted`
with a `retry-after` value. Nothing else is retried, since a retry would get the
same answer; in the browser a failed `fetch` reaches the client as `Unknown` and
is not retried. Set the policy when you create the client:

```typescript
const client = await MidenClient.create({
  rpcUrl: "testnet",
  noteTransportUrl: "testnet",
  noteTransportMaxRetries: 3, // integer 0..10, default 3
  noteTransportRetryIntervalMs: 250, // integer 0..60000, default 250, doubling
});
```

Besides each value's range, the two together may not exceed 120000 ms of total
computed backoff, `interval * (2^retries - 1)` with an omitted value taken at
its default. A value outside those bounds throws a `TypeError` before the client
is built.

The retries run inside the client's serialized call, so a slow or rate-limiting
transport blocks every other call on the client until the send finishes. A
non-zero `retry-after` from the service replaces the computed delay with no
upper bound, while a zero one falls back to the computed delay.
`noteTransportMaxRetries: 0` bounds a send to a single attempt, which suits a
latency-sensitive UI. `MidenClient.createMock()` ignores both options.

`@miden-sdk/react` relays private notes for you in `useSend`, `useMultiSend`
and `useTransaction`, and reports a note it could not deliver as a
`PrivateNoteDeliveryError` that `useResendPrivateNotes` takes; see the React
SDK's private note delivery page.
