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

## Manual Transaction Lifecycle

`client.transactions.submit(account, request)` runs the full pipeline — execute, prove, submit, apply — in one call. When you need to drive the stages yourself (benchmarking each step or handling errors per stage), `executeRequest` returns a staged handle you advance one step at a time. Each stage returns the handle for the next, carrying its own context so you never re-thread the result or block number:

```typescript
// 1. Execute — runs the request locally, nothing leaves the client.
const executed = await client.transactions.executeRequest(wallet, request);

// 2. Prove — pure computation over the execution; optional per-call prover.
const proven = await executed.prove({ prover: remoteProver });

// 3. Submit — sends the proof to the network. `submitted.blockNumber` is the height.
const submitted = await proven.submit();

// 4. Apply — persists the state changes into the local store.
await submitted.apply();
```

Notes on the staged form:

- **`executeRequest` does not persist anything.** Until `apply` runs, the local store doesn't know the transaction exists. If you stop after `submit()`, the network has the transaction but your local state won't reflect it until the next sync.
- **`prove` accepts an optional `{ prover }`** and otherwise falls back to the client's default prover (or the built-in local prover). A `TransactionProver` is consumed by the call — build (or clone) a fresh prover per `prove()`; reusing one silently falls back to local proving.
- **The stages are not atomic as a group.** Awaiting other mutating calls on the same account between them can interleave state — drive the chain as an uninterrupted sequence per account.
- **`apply` fires transaction observers** (e.g. PSWAP lineage tracking), the same as the one-shot `submit` path. `submitted.waitForConfirmation()` blocks until the transaction commits on-chain.
- **`submit` is equivalent** to running the stages back to back — prefer it unless you need the seams.
- **Proving elsewhere:** to submit a proof produced on a client that shares nothing with the executing one, pass it back in with `client.transactions.submitProven(proof, result)`, which returns the same submitted handle.

## Chain-Anchored Execution

By default a transaction executes against the client's current sync height. Since protocol 0.16 a signed transaction summary binds the reference block commitment, so signatures collected over a summary only authorize an execution whose reference block is the one the summary was built at.

That is a problem for any flow that collects signatures and executes later — a multisig proposal, offline co-signing — because the proposer, each co-signer, and the eventual executor are all at different heights. Re-deriving the summary locally produces a different summary, and the signatures no longer match.

A `ChainAnchor` pins execution to a specific reference block, so the same summary reproduces on any client:

```typescript
// ── Proposer ──────────────────────────────────────────────
const anchor = await client.transactions.captureAnchor(request);

// `preview` derives the summary the account is being asked to authorize.
const summary = await client.transactions.preview({
  operation: "custom",
  account: multisig,
  request,
  anchor,
});

await shipToCosigners({
  anchor: anchor.serialize(),
  summary: summary.serialize(),
});

// ── Co-signer ─────────────────────────────────────────────
const received = ChainAnchor.deserialize(anchorBytes);
const proposed = TransactionSummary.deserialize(summaryBytes);

// Re-derive at the proposer's anchor and compare before signing. Deriving at
// the local sync height would produce a different summary every time.
const derived = await client.transactions.preview({
  operation: "custom",
  account: multisig,
  request,
  anchor: received,
});
if (derived.toCommitment().toHex() !== proposed.toCommitment().toHex()) {
  throw new Error("proposal does not match the summary presented for signing");
}

// ── Executor ──────────────────────────────────────────────
await client.transactions.submit(multisig, request, { anchor: received });
```

Notes on anchors:

- **Verify anchors from untrusted parties.** An anchor validates its own internal consistency on `deserialize`, so it can never be malformed — but it can be pinned to the wrong block. Compare `anchor.commitment()` against the block commitment bound into the summary you were asked to sign before executing with it.
- **An anchor is captured for a specific request.** It tracks the creation blocks of that request's authenticated input notes, which is why `captureAnchor` takes the request. Executing a different request against it fails if that request consumes a note the anchor doesn't track.
- **The `anchor` option is only on the request-taking methods** — `preview({ operation: "custom" })`, `executeRequest`, and `submit`. `send`, `mint`, `consume` and friends build their request internally, so there is no request to have captured an anchor for.
- **Anchored execution skips the recency check**, since it deliberately references a block older than the tip.
- **Foreign account proofs are fetched at the anchor's block**, so requests with foreign accounts additionally need the node to serve account state at that height.
- **The anchor handle is reusable.** Unlike a `TransactionProver`, it is borrowed rather than consumed, so one anchor can drive the preview and the execution.
