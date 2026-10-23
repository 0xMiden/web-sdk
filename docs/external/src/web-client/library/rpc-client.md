---
title: Stateless RPC client
sidebar_position: 60
---

# Query and submit without a local store

Use `RpcClient` when your application manages its own account and note state
or receives transactions proved elsewhere. It connects directly to a node
without opening IndexedDB or a SQLite store. It does not execute, prove or
apply transactions, update local account state, or deliver private output notes
through note transport.

```typescript
import { Endpoint, RpcClient } from "@miden-sdk/miden-sdk";

const rpc = new RpcClient(Endpoint.testnet());
```

For a custom node, pass `new Endpoint(rpcUrl)`. The class is available from
the same eager/lazy and ST/MT entry points as `MidenClient`. With a lazy entry,
await `MidenClient.ready()` before constructing WASM objects.

## Find consumed notes

`syncNullifiers(prefixes, blockFrom, blockTo)` returns every matching
`NullifierUpdate` in the inclusive block range. Each update exposes
`nullifier(): Word` and `blockNum(): number`. The SDK handles request chunking
and pagination; the caller keeps its own sync cursor.

Prefixes are copied before asynchronous work and duplicate values are scanned
once, without modifying the caller's array. On Node.js, use an
`ArrayBuffer`-backed `Uint16Array`. A `SharedArrayBuffer` backing store is rejected
during argument conversion, so invalid input may throw before returning a Promise.

Prefixes are unsigned 16-bit values, taken from the high 16 bits of the fourth
field element of a nullifier. Prefixes can match unrelated nullifiers, so
compare the full returned values with the notes you track:

```typescript
import { RpcClient, Word } from "@miden-sdk/miden-sdk";

async function findConsumedNotes(
  rpc: RpcClient,
  trackedNullifiers: Word[],
  blockFrom: number,
  blockTo: number,
) {
  const expected = new Set(trackedNullifiers.map((word) => word.toHex()));
  const prefixes = Uint16Array.from(
    trackedNullifiers.map((word) => Number(word.toU64s()[3] >> 48n)),
  );
  const updates = await rpc.syncNullifiers(prefixes, blockFrom, blockTo);
  return updates.filter((update) => expected.has(update.nullifier().toHex()));
}
```

`blockFrom` must be at most `blockTo`, and `blockTo` must not exceed the node's
chain tip. Use `(await rpc.getBlockHeaderByNumber()).blockNum()` to obtain the
current upper bound. An empty prefix array returns an empty array without
contacting the node. After processing a completed range, start the next range
at `blockTo + 1`.

## Find included transactions

`syncTransactions(blockFrom, blockTo, accountIds)` returns every matching
`RpcTransactionRecord` in the inclusive block range. Each record exposes
`id(): TransactionId`, `accountId(): AccountId` and `blockNum(): number`.
These records come from the node and are distinct from the `TransactionRecord`
objects a stateful client tracks locally. No local store is opened or updated.

The SDK scans duplicate account IDs once and handles account-list chunking and
all pagination, including pages with no matching transactions. `blockFrom` must
be at most `blockTo`, and `blockTo`
must not exceed the node's chain tip. An empty account list returns `[]` without
contacting the node; a reversed range rejects.

For confirmation, start at the admission chain tip returned by submission and
look for the exact transaction ID. The caller retains its own polling cursor;
`syncTransactions` scans the requested range once and does not wait for future
blocks. After a successful scan, advance to `blockTo + 1`. If a scan fails,
retry from the same cursor.

```typescript
import { AccountId, RpcClient } from "@miden-sdk/miden-sdk";

async function pollForInclusion(
  rpc: RpcClient,
  accountIdHex: string,
  txIdHex: string,
  admissionTip: number,
  timeoutMs = 60_000,
): Promise<number | undefined> {
  let cursor = admissionTip;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const tip = (await rpc.getBlockHeaderByNumber()).blockNum();
    if (cursor <= tip) {
      const records = await rpc.syncTransactions(
        cursor, tip, [AccountId.fromHex(accountIdHex)],
      );
      const included = records.find((record) => record.id().toHex() === txIdHex);
      if (included) return included.blockNum();
      cursor = tip + 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return undefined; // Unconfirmed; the transaction may still be included later.
}
```

Use the canonical hex transaction ID returned by `TransactionId.toHex()`.
In the browser, `syncTransactions` consumes the `AccountId` wrappers even if it
rejects, so construct fresh wrappers from saved strings for each array entry,
poll or retry.
The example's timeout stops scheduling new scans; it does not cancel an RPC
already in flight. RPC errors propagate to the caller.

Treating a matching record as confirmation assumes trust in the configured
RPC node. The SDK checks that returned accounts were requested, but this
response does not independently prove inclusion in the canonical chain.
A polling timeout means **unconfirmed**, not failed.

## Submit a transaction proved elsewhere

Submission needs both a `ProvenTransaction` and its complete
`TransactionInputs`. The proof alone does not contain the private execution
inputs the validators need.

First fetch a `TransactionEncryptionKey` using your network's trusted genesis
commitment and a trusted block header. The SDK verifies the key's validator
attestation against that header and binds it to the genesis commitment. A
header fetched from the same untrusted RPC endpoint is not a trust anchor
unless your application independently validates it.

```typescript
import {
  BlockHeader,
  ProvenTransaction,
  RpcClient,
  TransactionInputs,
  Word,
} from "@miden-sdk/miden-sdk";

async function submitProvedTransaction(
  rpc: RpcClient,
  proof: ProvenTransaction,
  inputs: TransactionInputs,
  genesisCommitment: Word,
  trustedBlockHeader: BlockHeader,
): Promise<number> {
  const key = await rpc.getTransactionEncryptionKey(
    genesisCommitment,
    trustedBlockHeader,
  );
  return rpc.submitProvenTx(proof, inputs, key);
}
```

`submitProvenTx` seals the supplied inputs with the verified key before
sending them. It returns the node's chain tip at submission, **not** the block
in which the transaction committed. Keep the transaction ID and track
confirmation and local state in your application. For SDK-managed execution,
proving and local state updates, use the [transaction resource](transactions.md).

`TransactionInputs.fromTransactionResult(result)` extracts the inputs from
an existing SDK `TransactionResult`. For an external execution service,
deserialize its input payload with `TransactionInputs.deserialize(bytes)`.
The serialization formats are:

| Model | `serialize()` / `deserialize(bytes)` format |
| --- | --- |
| `ProvenTransaction` | Native Miden binary serialization. |
| `TransactionInputs` | `miden_objects::proto::transaction::TransactionInputs` protobuf encoding. |
| `ProposedBatch` | `miden_objects::proto::transaction::ProposedBatch` protobuf encoding. |
| `ProvenBatch` | `miden_objects::proto::transaction::ProvenBatch` protobuf encoding. |

Rust producers can convert each of the three protobuf models from its native
value and encode it with `prost::Message::encode_to_vec()`. These protobuf
payloads are not interchangeable with native `to_bytes()` serialization.

`RpcClient` does not cache the encryption key or retry submission after key
rotation. If the node rejects a retired key, fetch and verify the current key
before trying the submission again. The verified key exposes its identifier
through `keyId()`.

## Submit a proved batch

`submitProvenTxBatch` accepts a `ProvenBatch`, its matching `ProposedBatch`,
and one `TransactionInputs` per transaction, in exactly the proposal's order.
This is a batch proof produced by a batch prover, not an array of individually
proved transactions.

```typescript
import {
  ProposedBatch,
  ProvenBatch,
  RpcClient,
  TransactionEncryptionKey,
  TransactionInputs,
} from "@miden-sdk/miden-sdk";

async function submitProvedBatch(
  rpc: RpcClient,
  provenBatch: ProvenBatch,
  proposedBatch: ProposedBatch,
  transactionInputs: TransactionInputs[],
  key: TransactionEncryptionKey,
): Promise<number> {
  return rpc.submitProvenTxBatch(
    provenBatch,
    proposedBatch,
    transactionInputs,
    key,
  );
}
```

Deserialize the proposal and proof with `ProposedBatch.deserialize(bytes)` and
`ProvenBatch.deserialize(bytes)`. Proposal deserialization verifies its
transaction proofs and consistency; proven-batch deserialization checks its
structure. Submission checks that the proof matches the proposal and seals
the transaction inputs with the verified key.

The returned number is again the node's chain tip at submission, not a
commitment receipt. Local state updates, confirmation tracking and private
note delivery remain the caller's responsibility.

In the browser, the batch call consumes each `TransactionInputs` wrapper, even
when submission fails. Preserve `transactionInputs.map((inputs) =>
inputs.serialize())` before calling it and deserialize fresh wrappers for a
retry. The batch proof, proposal and key remain reusable. The single-transaction
call keeps all its arguments reusable.
