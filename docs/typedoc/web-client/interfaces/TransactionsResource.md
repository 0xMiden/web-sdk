[**@miden-sdk/miden-sdk**](../README.md)

***

[@miden-sdk/miden-sdk](../README.md) / TransactionsResource

# Interface: TransactionsResource

## Methods

### batch()

> **batch**(`options`): `Promise`\<[`BatchSubmitResult`](BatchSubmitResult.md)\>

Execute a heterogeneous batch of operations against a single account.
Each operation is built, proven individually and as a batch, and all
operations are submitted atomically — either every tx in the batch
lands or none does.

V1 supports only same-account batches (mirrors the underlying Rust
`Client::new_transaction_batch()` constraint).

#### Parameters

##### options

[`BatchOptions`](BatchOptions.md)

Batch options including the account and operations.

#### Returns

`Promise`\<[`BatchSubmitResult`](BatchSubmitResult.md)\>

***

### consume()

> **consume**(`options`): `Promise`\<[`TransactionSubmitResult`](TransactionSubmitResult.md)\>

Consume one or more notes for an account.

#### Parameters

##### options

[`ConsumeOptions`](ConsumeOptions.md)

Consume options including the account and notes to consume.

#### Returns

`Promise`\<[`TransactionSubmitResult`](TransactionSubmitResult.md)\>

***

### consumeAll()

> **consumeAll**(`options`): `Promise`\<[`ConsumeAllResult`](ConsumeAllResult.md)\>

Consume all available notes for an account, up to an optional limit.
Returns the count of remaining notes for pagination.

#### Parameters

##### options

[`ConsumeAllOptions`](ConsumeAllOptions.md)

Options including the account and optional max notes limit.

#### Returns

`Promise`\<[`ConsumeAllResult`](ConsumeAllResult.md)\>

***

### execute()

> **execute**(`options`): `Promise`\<[`TransactionSubmitResult`](TransactionSubmitResult.md)\>

Execute a custom transaction script with optional foreign account references.

#### Parameters

##### options

[`ExecuteOptions`](ExecuteOptions.md)

Execute options including the account, compiled script, and foreign accounts.

#### Returns

`Promise`\<[`TransactionSubmitResult`](TransactionSubmitResult.md)\>

***

### executeProgram()

> **executeProgram**(`options`): `Promise`\<`FeltArray`\>

Execute a program (view call) and return the resulting stack output.

#### Parameters

##### options

[`ExecuteProgramOptions`](ExecuteProgramOptions.md)

#### Returns

`Promise`\<`FeltArray`\>

***

### list()

> **list**(`query?`): `Promise`\<[`TransactionRecord`](../classes/TransactionRecord.md)[]\>

List transactions, optionally filtered by status, IDs, or expiration.

#### Parameters

##### query?

[`TransactionQuery`](../type-aliases/TransactionQuery.md)

Optional filter for transaction status, IDs, or expiration.

#### Returns

`Promise`\<[`TransactionRecord`](../classes/TransactionRecord.md)[]\>

***

### mint()

> **mint**(`options`): `Promise`\<[`TransactionSubmitResult`](TransactionSubmitResult.md)\>

Mint new tokens from a faucet account.

#### Parameters

##### options

[`MintOptions`](MintOptions.md)

Mint options including the faucet, recipient, and amount.

#### Returns

`Promise`\<[`TransactionSubmitResult`](TransactionSubmitResult.md)\>

***

### preview()

> **preview**(`options`): `Promise`\<[`TransactionSummary`](../classes/TransactionSummary.md)\>

Dry-run a transaction to preview its effects without submitting it to
the network.

#### Parameters

##### options

[`PreviewOptions`](../type-aliases/PreviewOptions.md)

Preview options discriminated by `operation` field.

#### Returns

`Promise`\<[`TransactionSummary`](../classes/TransactionSummary.md)\>

***

### send()

#### Call Signature

> **send**(`options`): `Promise`\<\{ `note`: `null`; `result`: `TransactionResult`; `txId`: [`TransactionId`](../classes/TransactionId.md); \}\>

Send tokens to another account by creating a pay-to-ID note. Set
`returnNote: true` to get the created note back.

##### Parameters

###### options

[`SendOptionsDefault`](SendOptionsDefault.md)

Send options including sender, recipient, token, and amount.

##### Returns

`Promise`\<\{ `note`: `null`; `result`: `TransactionResult`; `txId`: [`TransactionId`](../classes/TransactionId.md); \}\>

#### Call Signature

> **send**(`options`): `Promise`\<\{ `note`: [`Note`](../classes/Note.md); `result`: `TransactionResult`; `txId`: [`TransactionId`](../classes/TransactionId.md); \}\>

##### Parameters

###### options

[`SendOptionsReturnNote`](SendOptionsReturnNote.md)

##### Returns

`Promise`\<\{ `note`: [`Note`](../classes/Note.md); `result`: `TransactionResult`; `txId`: [`TransactionId`](../classes/TransactionId.md); \}\>

#### Call Signature

> **send**(`options`): `Promise`\<[`SendResult`](SendResult.md)\>

##### Parameters

###### options

[`SendOptions`](../type-aliases/SendOptions.md)

##### Returns

`Promise`\<[`SendResult`](SendResult.md)\>

***

### submit()

> **submit**(`account`, `request`, `options?`): `Promise`\<[`TransactionSubmitResult`](TransactionSubmitResult.md)\>

Submit a pre-built TransactionRequest. Note: WASM requires accountId
separately, so `account` is the first argument.

#### Parameters

##### account

[`AccountRef`](../type-aliases/AccountRef.md)

The account executing the transaction.

##### request

[`TransactionRequest`](../classes/TransactionRequest.md)

The pre-built transaction request.

##### options?

[`TransactionOptions`](TransactionOptions.md)

Optional transaction options (prover, confirmation).

#### Returns

`Promise`\<[`TransactionSubmitResult`](TransactionSubmitResult.md)\>

***

### submitBatch()

> **submitBatch**(`account`, `requests`, `options?`): `Promise`\<[`BatchSubmitResult`](BatchSubmitResult.md)\>

Submit pre-built TransactionRequests as an atomic batch. Plural
counterpart of [submit](#submit) — for callers that already have built
requests in hand and want to skip the high-level operation builders.

#### Parameters

##### account

[`AccountRef`](../type-aliases/AccountRef.md)

The account executing every transaction in the batch.

##### requests

[`TransactionRequest`](../classes/TransactionRequest.md)[]

Pre-built transaction requests (must be non-empty).

##### options?

`Omit`\<[`BatchOptions`](BatchOptions.md), `"account"` \| `"operations"`\>

Optional batch settings (waitForConfirmation, timeout, prover).

#### Returns

`Promise`\<[`BatchSubmitResult`](BatchSubmitResult.md)\>

***

### swap()

> **swap**(`options`): `Promise`\<[`TransactionSubmitResult`](TransactionSubmitResult.md)\>

Execute an atomic swap between two assets.

#### Parameters

##### options

[`SwapOptions`](SwapOptions.md)

Swap options including the account, offered asset, and requested asset.

#### Returns

`Promise`\<[`TransactionSubmitResult`](TransactionSubmitResult.md)\>

***

### waitFor()

> **waitFor**(`txId`, `options?`): `Promise`\<`void`\>

Poll until a transaction is confirmed on-chain. Throws on rejection
or timeout.

#### Parameters

##### txId

`string` \| [`TransactionId`](../classes/TransactionId.md)

The transaction ID to wait for.

##### options?

[`WaitOptions`](WaitOptions.md)

Optional polling timeout, interval, and progress callback.

#### Returns

`Promise`\<`void`\>
