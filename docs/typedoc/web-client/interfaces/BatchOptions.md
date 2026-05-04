[**@miden-sdk/miden-sdk**](../README.md)

***

[@miden-sdk/miden-sdk](../README.md) / BatchOptions

# Interface: BatchOptions

## Properties

### account

> **account**: [`AccountRef`](../type-aliases/AccountRef.md)

The account executing every operation in the batch (single-account in V1).

***

### operations

> **operations**: [`BatchOperation`](../type-aliases/BatchOperation.md)[]

Operations to execute atomically as a batch. Must be non-empty.

***

### prover?

> `optional` **prover?**: [`TransactionProver`](../classes/TransactionProver.md)

Override default prover.

***

### timeout?

> `optional` **timeout?**: `number`

Wall-clock polling timeout for `waitForConfirmation` (default 60_000ms).

***

### waitForConfirmation?

> `optional` **waitForConfirmation?**: `boolean`

Wait until the batch's block has been observed in the local sync height.
Differs from singular `waitForConfirmation`: the V1 batch API returns
only a block number, so we poll chain height rather than per-tx status.
