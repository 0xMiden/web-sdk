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
