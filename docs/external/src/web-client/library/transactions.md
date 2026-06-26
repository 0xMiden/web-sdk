---
title: Transactions
sidebar_position: 10
---

# Working with Transactions in the Miden SDK

This guide demonstrates how to send, batch, and retrieve transactions using the Miden SDK.

## Listing All Transactions

```typescript
import { MidenClient } from "@miden-sdk/miden-sdk";

try {
    const client = await MidenClient.create();

    // List all transactions
    const allTransactions = await client.transactions.list();

    for (const tx of allTransactions) {
        console.log("Transaction ID:", tx.id().toString());
        console.log("Account ID:", tx.accountId().toString());
        console.log("Block Number:", tx.blockNum().toString());

        // Check transaction status
        const status = tx.transactionStatus();
        if (status.isPending()) {
            console.log("Status: Pending");
        } else if (status.isCommitted()) {
            console.log("Status: Committed in block", status.getBlockNum());
            console.log("Committed at:", status.getCommitTimestamp());
        } else if (status.isDiscarded()) {
            console.log("Status: Discarded");
        }

        // Account state changes
        console.log("Initial State:", tx.initAccountState().toHex());
        console.log("Final State:", tx.finalAccountState().toHex());

        // Notes information
        console.log("Input Note Nullifiers:", tx.inputNoteNullifiers().map(n => n.toHex()));
        console.log("Output Notes:", tx.outputNotes().toString());
    }
} catch (error) {
    console.error("Failed to retrieve transactions:", error.message);
}
```

## Filtering Transactions

```typescript
import { MidenClient } from "@miden-sdk/miden-sdk";

try {
    const client = await MidenClient.create();

    // Get uncommitted transactions
    const uncommitted = await client.transactions.list({ status: "uncommitted" });
    for (const tx of uncommitted) {
        console.log("Uncommitted:", tx.id().toString());
    }

    // Get specific transactions by ID
    const specific = await client.transactions.list({ ids: [txId1, txId2] });

    // Get expired transactions
    const expired = await client.transactions.list({ expiredBefore: 1000 });
} catch (error) {
    console.error("Failed to filter transactions:", error.message);
}
```

## Transaction Statuses

Transactions can have the following statuses:
- **Pending** — Transaction is waiting to be processed
- **Committed** — Transaction has been successfully included in a block
- **Discarded** — Transaction was discarded and will not be processed

Check status using methods on the `TransactionStatus` object:
- `isPending()` — Returns `true` if the transaction is pending
- `isCommitted()` — Returns `true` if the transaction is committed
- `isDiscarded()` — Returns `true` if the transaction is discarded
- `getBlockNum()` — Returns the block number if committed, otherwise `null`
- `getCommitTimestamp()` — Returns the commit timestamp if committed, otherwise `null`

## Batch Operations

Submit multiple operations against a single account as one atomic batch — every transaction in the batch lands together or none does. Each operation builds its own `TransactionRequest` internally, so consumers don't have to assemble or serialize them by hand.

```typescript
const { blockNumber } = await client.transactions.batch({
  account: wallet,
  operations: [
    { kind: "send", to: alice, token: dagToken, amount: 50n, type: "public" },
    { kind: "send", to: bob, token: dagToken, amount: 30n, type: "public" },
    { kind: "consume", notes: pendingNotes },
  ],
  waitForConfirmation: true,
});
console.log(`Batch landed in block ${blockNumber}`);
```

### Operation kinds

`BatchOperation` is a discriminated union on `kind`. Each shape mirrors the singular options object (`SendOptions`, `MintOptions`, …) minus the `account` field, which is set once at the batch level:

| `kind` | Fields |
|---|---|
| `"send"` | `to`, `token`, `amount`, `type?`, `reclaimAfter?`, `timelockUntil?` |
| `"mint"` | `to`, `amount`, `type?` |
| `"consume"` | `notes` (single `NoteInput` or array) |
| `"swap"` | `offer: { token, amount }`, `request: { token, amount }`, `type?`, `paybackType?` |
| `"execute"` | `script`, `foreignAccounts?` |
| `"custom"` | `request: TransactionRequest` (escape hatch for pre-built requests) |

### V1 constraints

- **Single account.** Every operation runs against the `account` passed at the top level. Mixing accounts across operations throws — V2 will lift this constraint.
- **No per-tx ids in the result.** `batch` returns `{ blockNumber }`. To inspect individual transactions in the batch, sync state and query with `client.transactions.list()` after `waitForConfirmation` succeeds.
- **Atomicity is at the batch level.** Either all transactions in the batch land or none do — this differs from `Promise.all([send, send, send])` of singular calls (which can partially succeed).

### `submitBatch` — pre-built requests

For callers that already hold pre-built `TransactionRequest`s, `submitBatch` skips the high-level builders:

```typescript
const { blockNumber } = await client.transactions.submitBatch(wallet, [
  request1,
  request2,
]);
```

This is the plural counterpart of `client.transactions.submit(account, request)` — same escape-hatch semantics for the rare case where you've assembled requests outside the resource layer.

### `waitForConfirmation` semantics

The V1 batch primitive returns only a block number — there are no per-tx ids to poll. Setting `waitForConfirmation: true` polls the local sync height until it reaches `blockNumber` (rather than per-transaction polling like singular `send` / `consume` do). The `timeout` option still applies; default is 60 seconds.
