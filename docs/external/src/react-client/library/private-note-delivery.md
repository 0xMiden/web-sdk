---
title: Private note delivery
sidebar_position: 12
---

# Private note delivery

A private note lives on-chain only as a commitment, so its recipient learns of
it when the sender relays the note details through the note transport. `useSend`
and `useMultiSend` do that for every private note they create, and
`useTransaction` does it for the private output notes of a request when you
pass `privateNoteTarget`. The hook waits for the transaction to commit, because
the relay carries the note's inclusion proof, and then relays each note.

```tsx
import {
  PrivateNoteDeliveryError,
  useResendPrivateNotes,
  useSend,
} from "@miden-sdk/react";

function PrivateSendButton({ from, to, assetId }) {
  const { send, isLoading, stage } = useSend();
  const { resend } = useResendPrivateNotes();

  const handleSend = async () => {
    try {
      const { txId } = await send({
        from,
        to,
        assetId,
        amount: 100n,
        noteType: "private",
      });
      console.log("Sent and delivered", txId);
    } catch (err) {
      if (err instanceof PrivateNoteDeliveryError) {
        // The transaction went through; only the delivery is outstanding.
        console.warn(err.transactionId, err.commitment, err.undelivered);
        await resend({
          transactionId: err.transactionId,
          notes: err.undelivered,
        });
      } else {
        throw err;
      }
    }
  };

  return (
    <button onClick={handleSend} disabled={isLoading}>
      {isLoading ? `${stage}...` : "Send privately"}
    </button>
  );
}
```

## When a note is not delivered

Delivery can fail after the transaction is already on its way, so the hooks
report it separately from a failed transaction. Once
`submitProvenTransaction` has succeeded, a hook that owed private notes and did
not deliver all of them rejects with `PrivateNoteDeliveryError`, a `MidenError`
with code `PRIVATE_NOTE_DELIVERY_FAILED`. It carries:

| Field | Meaning |
|---|---|
| `transactionId` | The submitted transaction, as hex. It is not retried and not undone. |
| `commitment` | `"committed"` when the hook saw the transaction commit before relaying, otherwise `"unknown"`. |
| `delivered` | Notes that reached the transport, each `{ noteId, to }`. |
| `undelivered` | Notes that did not, in the same shape. |
| `cause` | The first underlying error. |

`to` is the recipient in a form the hooks accept again: the string you passed,
or the account id as hex when you passed an `AccountId`, `Account` or
`AccountHeader`.

What happens at each point after the transaction is submitted:

- **Applying it locally fails.** The error reports every owed note as
  undelivered with `commitment: "unknown"`. Those notes never reached this
  client's store, so this client cannot resend them.
- **The commit wait sees the transaction discarded.** The call rejects with a
  plain error: the transaction did not land, so nothing is owed.
- **The commit wait times out.** Every owed note is undelivered, with
  `commitment: "unknown"`.
- **A relay fails after commit.** Every owed note is still attempted, so
  `useMultiSend` does not stop at the first recipient. The error lists which
  notes were delivered and which were not, with `commitment: "committed"`.
- **This client holds no details for a note** (a partial output note). The note
  is still relayed by id, the relay rejects it ("output note has no details to
  relay"), and it is reported as undelivered with `commitment: "committed"`.
  This client cannot resend it.

A failure before or at submission is a plain error, as it always was:
`useTransaction` checks `privateNoteTarget` before it executes anything, so a
malformed target fails there. In every case the hook's `error` is set, `result`
is `null` and `stage` returns to `"idle"`; each call clears the previous
`result` when it starts.

## Sending the notes again

The SDK keeps no queue and no sync re-sends a note, so the error is the only
record of what is still owed. `useResendPrivateNotes()` returns
`{ resend, isLoading, error }`. `resend({ transactionId, notes })` syncs once,
so a note whose transaction has committed since has the proof it needs, then
relays every note through the provider's `runExclusive` lock. It resolves once
all are delivered and otherwise rejects with a new `PrivateNoteDeliveryError`
carrying the same `transactionId`, `commitment: "unknown"` and the notes that
still failed. One sync does not guarantee the transaction has committed, so a
resend can fail again for that reason alone; delivery is idempotent by note id,
so repeating it is safe.

## Transport retries

Each relay already retries a transient transport failure before it gives up:
a failed connection, `Unavailable`, `DeadlineExceeded`, or `ResourceExhausted`
with a `retry-after` value. In the browser a failed `fetch` is not retried.
Tune this on the provider:

```tsx
<MidenProvider
  config={{
    rpcUrl: "testnet",
    noteTransportMaxRetries: 3, // 0..10, default 3
    noteTransportRetryIntervalMs: 250, // 0..60000 ms, default 250, doubling
  }}
>
  <App />
</MidenProvider>
```

Besides each value's range, the two together may not exceed 120000 ms of total
computed backoff, `interval * (2^retries - 1)` with an omitted value taken at
its default; anything else throws a `TypeError` when the client is built.

The retries run inside the client's serialized call and, in these hooks, under
the provider lock, so a slow or rate-limiting transport blocks every other
client call until the send finishes. A non-zero `retry-after` from the service
replaces the computed delay with no upper bound, while a zero one falls back to
the computed delay. `noteTransportMaxRetries: 0` bounds a send to a single
attempt, which suits a latency-sensitive UI.
