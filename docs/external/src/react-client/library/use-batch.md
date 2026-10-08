---
title: useBatch
sidebar_position: 12
---

# useBatch

Submit multiple transactions across one or more tracked accounts as one atomic
batch: every tx lands together or none does. Each item pairs a local account
with a pre-built `TransactionRequest`, and later items may consume notes
produced by earlier ones, even across accounts.

```tsx
import { useBatch, useMidenClient } from "@miden-sdk/react";
import { NoteType } from "@miden-sdk/miden-sdk";

function BatchButton() {
  const { batch, result, isLoading, stage, error, reset } = useBatch();
  const client = useMidenClient();

  const handleBatch = async () => {
    const sendReq = await client.newSendTransactionRequest(
      alice, bob, token, NoteType.Private, 50n, null, null
    );
    const consumeReq = await client.newConsumeTransactionRequest([incomingNote], bob);

    const { blockNumber } = await batch({
      items: [
        { account: alice, request: sendReq },
        { account: bob, request: consumeReq }, // can consume notes from earlier items
      ],
    });
    console.log("Batch submitted at chain tip", blockNumber);
  };

  return (
    <div>
      {error && <div>Error: {error.message}</div>}
      <button onClick={handleBatch} disabled={isLoading}>
        {isLoading ? `Submitting (${stage})...` : "Submit batch"}
      </button>
      {result && <div>Submitted at chain tip {result.blockNumber}</div>}
    </div>
  );
}
```

`batch({ items, skipSync? }) → { blockNumber }`. The underlying primitive
returns a block number rather than per-tx ids, so the result carries only that
number: the node's chain tip as of submission, not the block the batch commits
in. Sync to learn where it landed.

## Options

| Field | Type | Description |
|---|---|---|
| `items` | `{ account: AccountRef; request: TransactionRequest }[]` | Per-tx pairs, in push order. Must be non-empty. Every `account` must be tracked by this client. |
| `skipSync` | `boolean` | Optional. Skip the sync before submitting. Defaults to `false`. |

## Behavior

- **Push order.** Items run in array order, so a note producer must come before
  its consumer.
- **Proving.** Each tx is proven inside the batch primitive by the client's
  built-in local prover, so `MidenProvider`'s `prover` setting and its fallback
  do not apply to batches.
- **Threading.** In the browser the batch runs in the client's Web Worker, so
  the page stays responsive while it proves. With `useWorker: false`, or without
  `Worker` support, it proves on the calling thread and blocks the page until it
  settles, so keep batches small there.
- **Stages.** `stage` goes `"executing"` → `"submitting"` → `"complete"`. There
  is no `"proving"` stage, because proving happens inside the batch primitive. A
  failure after the batch starts returns `stage` to `"idle"` and sets `error`;
  the guards below throw without touching hook state.
- **Concurrency guard.** A second `batch()` while the first is still in flight
  throws a `MidenError` with `code: "BATCH_BUSY"`.
- **Signer check.** With a signer provider mounted but disconnected, `batch()`
  throws before submitting anything.
- **Sync.** The hook syncs before submitting unless `skipSync: true`, and syncs
  again after the batch is accepted.

## Fees

The hook submits your requests as they are and declares no fee conversion salt.
Requests against ordinary accounts pay normally; build a multisig item's request
from `client.feeAwareTransactionRequestBuilder(account)`, or its push fails
with `FeeConversionInfoRequired`.

## See also

- [Batch operations](../../web-client/library/transactions.md#batch-operations) - the underlying `MidenClient` batch API and its constraints.
