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
    const client = await MidenClient.create({ feeFaucetId: FEE_FAUCET });

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
    const client = await MidenClient.create({ feeFaucetId: FEE_FAUCET });

    // Get uncommitted transactions
    const uncommitted = await client.transactions.list({ status: "uncommitted" });
    for (const tx of uncommitted) {
        console.log("Uncommitted:", tx.id().toString());
    }

    // Get specific transactions by ID
    const specific = await client.transactions.list({ ids: [txId1, txId2] });
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

## Reading Transaction Logs

An account procedure can emit logs while a transaction executes, with `add_log` or `add_log_from_memory` of `miden::protocol::tx`. Each log has an emitter, a topic and content words. The client stores the logs of every transaction that it applies, so `client.transactions.logs` reads them from the store and does not contact the node:

```typescript
const logs = await client.transactions.logs(txId);

if (logs === null) {
    // The client does not track this transaction.
} else {
    console.log("Logs:", logs.numLogs());
    for (const log of logs.logs()) {
        console.log("Emitter:", log.emitter().toString());
        console.log("Topic:", log.topicPrefix().toString(), log.topicSuffix().toString());
        console.log("Content:", log.content().map((word) => word.toHex()));
    }
}
```

- **`txId` is a hex string or a `TransactionId`.** The result is `null` for a transaction that the client does not track, and an empty collection (`logs.isEmpty()`) for a transaction that emitted no logs.
- **The logs are in emission order.** `logs.commitment()` commits to the logs and to their order.
- **The emitter can be a foreign account.** `log.emitter()` is the account whose procedure emitted the log, which is not always the account that executed the transaction.
- **The topic is two field elements**, `topicPrefix()` and `topicSuffix()`. The procedure that emits the log chooses them.
- **The logs are stored when the transaction is applied**, so they are available before the transaction is committed. The store also keeps the logs of a discarded transaction. The network did not apply those logs.

The same collection is available earlier: `result.executedTransaction().logs()` returns the logs of an executed transaction before it is submitted, and `summary.logs()` returns the logs that a transaction summary binds.

### Logs of a transaction that the client does not track

`RpcClient.getTransactionLogs` fetches the logs of a committed transaction from the node. The node holds the logs of a public account. For a private account it holds only the commitment to the logs.

```typescript
import { AccountId, Endpoint, RpcClient, TransactionId } from "@miden-sdk/miden-sdk";

const rpc = new RpcClient(new Endpoint(client.endpoint()!));
const info = await rpc.getTransactionLogs(
    AccountId.fromHex(accountHex),
    TransactionId.fromHex(txHex)
);

if (info === undefined) {
    // The node has no committed transaction with this ID for this account.
} else {
    console.log("Block:", info.blockNum(), "index in block:", info.transactionIndex());
    console.log("Logs commitment:", info.logsCommitment().toHex());

    const logs = info.logs(); // undefined for a private account
}
```

- **Both IDs are required.** The node returns `undefined` when the transaction belongs to another account.
- **Only committed transactions have logs on the node.** For a pending transaction the result is `undefined`, while `client.transactions.logs` already returns its logs.
- **The result relies on trusting the node.** It does not prove that the transaction is in the canonical chain.

## Batch Operations

Submit multiple operations across one or more local accounts as one atomic batch — every transaction in the batch lands together or none does. Each operation builds its own `TransactionRequest` internally, so consumers don't have to assemble or serialize them by hand.

The guarantee comes from the node's `SubmitProvenTxBatch` RPC contract: "All transactions in this batch will be considered atomic, and be committed together or not all." It does not exempt the transactions from building on the current mempool state under the normal submission rules — `miden-client`'s RPC trait spells that out on the same endpoint — so atomicity governs how the batch commits, not whether the node accepts it.

```typescript
const { blockNumber } = await client.transactions.batch({
  operations: [
    { kind: "send", account: alice, to: bob, token: dagToken, amount: 50n, type: "public" },
    { kind: "send", account: alice, to: carol, token: dagToken, amount: 30n, type: "public" },
    { kind: "consume", account: bob, notes: pendingNotes },
  ],
});
// The node's chain tip as of submission, not the block the batch commits in.
console.log(`Batch submitted at chain tip ${blockNumber}`);
```

### Operation kinds

`BatchOperation` is a discriminated union on `kind`. Each shape carries the request-building fields of its singular options object (`SendOptions`, `MintOptions`, …) and none of the per-submission ones. Every operation specifies which local account executes it via `account`, and neither `prover`, `waitForConfirmation` and `timeout` nor `returnNote`, which selects a different request shape, has any per-operation meaning:

| `kind` | Fields |
|---|---|
| `"send"` | `account`, `to`, `token`, `amount`, `type?`, `reclaimAfter?`, `timelockUntil?` |
| `"mint"` | `account`, `to`, `amount`, `type?` |
| `"consume"` | `account`, `notes` (single `NoteInput` or array) |
| `"swap"` | `account`, `offer: { token, amount }`, `request: { token, amount }`, `type?`, `paybackType?` |
| `"execute"` | `account`, `script`, `foreignAccounts?` |
| `"custom"` | `account`, `request: TransactionRequest` (escape hatch for pre-built requests) |

### Cross-account flows

A later transaction may consume a note produced by an earlier transaction in the same batch — even when the producer and consumer target different accounts. Push order must respect producer-before-consumer.

### Constraints

- **All accounts must be tracked.** Every `account` referenced by an operation must be registered with the client. Pushing for an unknown account fails at submit time with `AccountDataNotFound`.
- **No per-tx ids in the result.** `batch` returns `{ blockNumber }`, the node's chain tip as of submission. To inspect individual transactions in the batch, sync state and query with `client.transactions.list()`.
- **On a mock client, call `proveBlock()` after a batch** before submitting anything else. A submitted batch is not part of the serialized mock chain, so a later mock submit that round-trips through the worker adopts a chain that never saw it. A mock batch also proves for real whether you ask it to or not: the mock client's dummy-prover shortcut applies only when no prover was passed, and the batch builder bypasses it entirely, so budget more time for a mock batch than for other mock submits.
- **Atomicity is at the batch level.** Either all transactions in the batch land or none do — this differs from `Promise.all([send, send, send])` of singular calls (which can partially succeed).
- **No duplicate input notes.** A note consumed by one transaction in the batch cannot be consumed by another — globally across accounts.
- **Proving uses the built-in local prover.** Each transaction is proven inside the batch primitive by the client's built-in local prover, so `proverUrl` does not apply to `batch` or `submitBatch`, and neither takes a per-call prover.
- **Proving runs in the Web Worker where there is one.** In the browser the client forwards a batch to its Web Worker, so the page keeps responding while the batch proves. With `useWorker: false`, where no `Worker` exists, or on a mock client, it proves on the calling thread and blocks it until it settles, so keep batches small there. Either way the batch holds the client: its other calls queue behind it until it settles. With an external keystore, the batch signs while it is built, and through the Web Worker `sign` waits without a limit unless `callbackTimeoutMs` sets one, so a stalled signer holds the batch and leaves later worker calls in the queue. To fail a stalled signer instead, set a finite timeout, such as `MidenClient.create({ keystore, callbackTimeoutMs: 120000 })`. See the [complete callback timeout contract](https://github.com/0xMiden/web-sdk/blob/main/crates/web-client/README.md#keystore-callback-timeouts).

### `submitBatch` — pre-built requests

For callers that already hold pre-built `TransactionRequest`s, `submitBatch` skips the high-level builders. Each item pairs the executing account with its request:

```typescript
const { blockNumber } = await client.transactions.submitBatch([
  { account: alice, request: request1 },
  { account: bob, request: request2 },
]);
```

This is the plural counterpart of `client.transactions.submit(account, request)` — same escape-hatch semantics for the rare case where you've assembled requests outside the resource layer.

### `waitForConfirmation` semantics

The batch primitive returns only a block number, and that number is the node's chain tip at submission, per the caveat above, so reaching it says nothing about the batch. With `waitForConfirmation: true` the call instead follows the transactions the submission recorded in the local store: it syncs the chain and resolves once every one of them is committed. It rejects with `Batch transaction rejected: <id>` if the node discards one, and with `Batch confirmation timed out` when `timeout` runs out first; the default is 60 seconds, and `0` polls until the batch settles.

```typescript
await client.transactions.batch({
  operations,
  waitForConfirmation: true,
});
```

The batch's own effects are already in the local store when the call returns, so without the option what you are waiting for is chain inclusion:

```typescript
await client.sync();
const txs = await client.transactions.list();
```

Two failure modes worth handling after a batch submit:

1. The node can accept a batch and the local store update still fail, which surfaces as `code: "ApplyTransactionAfterSubmitFailed"` (or a message containing `batch was accepted at block N but building store updates failed` / `applying to the store failed`). The node has taken the batch in that case, so do not submit it again; sync instead.
2. The submission can come back without a definite outcome (`code: "BATCH_SUBMISSION_OUTCOME_UNKNOWN"`). Nothing was recorded locally, and the node may or may not have accepted the batch. The error carries `submission` (in-thread) or `submissionId` (Web Worker) plus `transactionIds`. Resend with `client.transactions.retryProvenBatch(error.submission ?? { submissionId: error.submissionId })` without calling `batch` / `submitBatch` again (a new prove changes identities). After a successful retry, confirm with `waitFor` / `list` for those ids. A conflict on retry usually means the original attempt landed, but a rejected retry records nothing locally and a sync does not insert the missing records, so look the ids up on the node, not in the local store. Browser builds only: Node.js errors prefix the message with the code and carry no submission handle or `transactionIds`.

Accepting a transaction proved by another participant as a batch member needs a rust-sdk release that exposes `push_proven_transaction` on the pinned client; that half of [#571](https://github.com/0xMiden/web-sdk/issues/571) is a follow-up.

## MASM assertion diagnostics

Browser transaction errors can include a `masm` diagnostic when the VM reports a failed assertion. The diagnostic contains the full-precision decimal `errorCode` string. When available, it also gives the `assertionMessage` and a source `file` URI with a byte `span` (`start` inclusive, `end` exclusive). The same fields are available in-thread and through the Web Worker. Production builds can strip assertion text and source locations from protocol and standard scripts. Node.js keeps its existing error message.

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

Clients sharing a browser database read coherent persisted account state.
Account witnesses refresh when another client changes that state, preserving
untouched vault assets and storage maps. This does not fetch new chain state;
continue to sync before relying on on-chain balances.

For browser stores, `apply` requires the stored account to match the
transaction's execution input. A mismatch rejects before changing account state
or transaction history. A submitted transaction is already accepted by the node when
local apply fails, so `apply` and the single-transaction `transactions.*` helpers
(which apply after submitting) reject with `code: "ApplyTransactionAfterSubmitFailed"`,
`transactionId`, `submissionHeight` and the original error as `cause`. A batch whose
local update fails after the node accepted it rejects with the same `code` and the
accepted block in its message, without those fields. Do not submit it again.

## Pinning How Input Notes Are Consumed

`withInputNotes` adds notes and leaves the executing client to decide how each one is consumed: authenticated when its store holds the note's inclusion proof, unauthenticated otherwise. That is what you want for a request you build and execute yourself. It is not what you want for a request that travels — two clients with different stores produce different transaction summaries for the same request, and a multisig flow comparing summaries then fails for no visible reason.

`withExplicitInputNote` pins the mode on the request instead. Each note is consumed in the mode its `InputNote` carries, whatever the executing client's store holds:

```typescript
import { InputNote, TransactionRequestBuilder } from "@miden-sdk/miden-sdk";

const request = new TransactionRequestBuilder()
  // Consumed with its proof and optional arguments.
  .withExplicitInputNote(InputNote.authenticated(note, inclusionProof), args)
  // Consumed as unauthenticated, even if the executing client has a proof for it.
  .withExplicitInputNote(InputNote.unauthenticated(otherNote))
  .build();
```

Each call adds one note. The optional second argument is the note's arguments, the same value `withInputNotes` takes; omit it or pass `null` for none. The input note remains usable after the call.

To consume an authenticated note, the executing client must be able to serve the header of the note's creation block.

## Skipping Invalid Notes, Network Scripts and Code Upgrades

`ignoreInvalidInputNotes()` makes execution drop an input note the account can no longer consume, without an error, and consume the rest. `request.ignoresInvalidInputNotes()` reports the flag. Execution screens at most 20 input notes this way and fails with `invalid input note count` above that, so split a larger batch across requests.

```typescript
const request = new TransactionRequestBuilder()
  .withInputNotes(notes)
  .ignoreInvalidInputNotes()
  .build();
```

`withExpectedNtxScripts(scripts)` declares the note scripts the network will run for the request, and `request.expectedNtxScripts()` reads the declared list back, standard scripts included. The web client submits exactly the request it is given and registers nothing, so register each custom script the node does not know yet first. `client.newRegisterNoteScriptsTransactionRequest(sender, scripts)` builds a request that emits one public note per script, with no assets and no storage; submit it from `sender` before the network transaction that needs the scripts. The node resolves standard scripts itself.

```typescript
const scripts = new NoteScriptArray([customScript]);
const register = await client.newRegisterNoteScriptsTransactionRequest(
  sender,
  scripts
);
await client.submitNewTransaction(sender, register);
```

`buildAccountCodeUpgrade(code)` finalizes a request that upgrades the executing account to `code`. The account needs the `UpgradeManager` component with `AuthControlled` authority, and `code` must keep the storage layout. It replaces any custom script and script argument, and fails when own output notes or an expiration delta are set. `withAccountCodeUpgrade(code)` only places the code in the advice map, and `request.accountCodeUpgrade()` returns it.

`extendMerkleStore(nodes)` adds Merkle tree nodes to the store the transaction executes with, so its scripts can read Merkle paths through them. Each `InnerNodeInfo(value, left, right)` is stored as given: `value` must be the Poseidon2 merge of `left` and `right`, and it is not checked. `request.merkleStoreInnerNodes()` returns the added nodes, without the empty-subtree nodes every store starts with.

```typescript
const nodes = new InnerNodeInfoArray([new InnerNodeInfo(value, left, right)]);
const request = new TransactionRequestBuilder().extendMerkleStore(nodes).build();
```

## Claiming an inbound AggLayer deposit

`Note.createClaimNote(...)` builds the public CLAIM note that asks the AggLayer bridge to mint an inbound deposit. The proof and leaf come from the AggLayer `claimAsset` data; the Miden amount is derived from the leaf's uint256 amount and the faucet's decimal scale, `floor(amount / 10^scale)`, which is what the bridge verifies.

```typescript
const proof = new ClaimProofData(
  smtProofLocalExitRoot, // 32 hex nodes
  smtProofRollupExitRoot, // 32 hex nodes
  globalIndex,
  mainnetExitRoot,
  rollupExitRoot
);
const leaf = new ClaimLeafData(
  originNetwork,
  EthAddress.fromHex(originTokenAddress),
  destinationNetwork,
  EthAddress.fromHex(destinationAddress),
  "100000000000000000000", // uint256 amount as a decimal string
  metadataHash
);
const note = Note.createClaimNote(proof, leaf, 10, bridgeAccountId, senderId);
```

A scale above 18, or a scaled amount above the maximum fungible amount, throws. Submit it with `client.transactions.claimAggLayerDeposit(...)`, which builds the same note, sends it as an own output note of the sender and declares the bridge account as a foreign account, as for any network note. It returns `{ txId, note, result }`. A `scale` that is not an integer from 0 to 18 throws before any WASM call.

```typescript
const { txId, note } = await client.transactions.claimAggLayerDeposit({
  account: wallet, // sender, the executing account
  bridgeAccount: bridgeAccountId, // public bridge; consumes the note and mints the deposit
  proof,
  leaf,
  scale: 10, // the faucet's decimal scale
});
```

## Withdrawing USDCx (Circle xReserve)

`client.transactions.withdrawUsdcx(...)` emits a single public burn note with the fixed `BURN` tag. The USDCx faucet, a public account, consumes and burns it, and Circle releases USDC to the recipient on the destination domain.

```typescript
await client.transactions.withdrawUsdcx({
  account: wallet, // sender, the executing account
  token: usdcxFaucet, // public USDCx faucet; consumes the note and burns the asset
  amount: 1_000_000n, // a number must be a safe integer; use a bigint above 2 ** 53 - 1
  destinationDomain: 6, // Circle domain id
  destinationRecipient: "0x0000000000000000000000001111111111111111111111111111111111111111", // 32 bytes
});
```

`destinationRecipient` is a `0x`-prefixed 64-digit hex string, validated before any WASM call. An EVM address is left-padded with zeros to 32 bytes. The lower-level builders are `Note.createXReserveBurnNote(...)` and `client.newXReserveBurnTransactionRequest(...)`, which take the recipient as a 32-byte `Uint8Array`.

## Paying Transaction Fees

Since protocol 0.16 a chain can charge a verification fee, and the fee is paid from inside the account's auth procedure rather than by the transaction kernel. `fee::pay_fee` reads the asset and rate to pay in out of the transaction's auth argument: `AUTH_ARGS` has to be `hash(CONVERSION_INFO || SALT)`, with the preimage reachable in the advice map. A procedure that reaches `pay_fee` without that commitment aborts with `ERR_FEE_CONVERSION_INFO_MISSING`.

**Fees are always settled in the chain's own fee asset at rate 1/1**, so there is no conversion info for you to choose — miden-client builds it and commits it through the auth args while preparing the transaction. The one thing it will not invent is the **salt** the commitment is computed under, because every multisig flavour reuses that salt as its transaction summary's replay guard, and only the caller can choose a value the co-signers will agree on.

So how much of this you have to think about depends on the account:

- **Single-sig, no-auth and network accounts** — nothing to do, at any base fee. miden-client commits under a fixed default salt. It is fixed deliberately: the signed transaction summary covers the auth args, so a fresh salt per execution would change the summary and break any flow that reproduces one to verify a signature over it.
- **Multisig, smart multisig and guarded multisig** — miden-client refuses to guess the salt, and the transaction fails with `FeeConversionInfoRequired` naming the component. Declaring a salt is what makes those accounts work at all.
- **A custom auth procedure that reads conversion info** — miden-client does not recognise the component, commits nothing, and the transaction hits the VM abort above. Attach the commitment yourself; see [Custom auth procedures](#custom-auth-procedures).

Whether any of this applies is a property of the chain, and `BlockHeader.verificationBaseFee()` is how you ask. The node serves the block header; the fee asset itself comes from the client, since 0.17 keeps it in the protocol configuration rather than in the header (`client.protocolConfig()` returns that configuration, whose `commitment()` is the header's `protocolConfigCommitment()`):

```typescript
import { Endpoint, RpcClient } from "@miden-sdk/miden-sdk";

const rpc = new RpcClient(new Endpoint(client.endpoint()!));
// Without a block number, the node returns its latest header.
const header = await rpc.getBlockHeaderByNumber();

const chargesFees = header.verificationBaseFee() > 0;
const feeFaucet = await client.feeFaucetId();
```

On a chain that charges nothing, a request for an account that is not a multisig is byte-identical to what earlier versions produced — no auth argument, no declared salt, no advice entry. A multisig is the exception at any base fee: since 0.17 its auth procedure resolves its auth args unconditionally, so the request carries them even on a fee-free chain.

### The convenience constructors handle it

`newSendTransactionRequest`, `newMintTransactionRequest`, `newConsumeTransactionRequest`, `newSwapTransactionRequest`, `newB2AggTransactionRequest`, `newXReserveBurnTransactionRequest`, `newPswapCreateTransactionRequest`, `newPswapConsumeTransactionRequest` and `newPswapCancelTransactionRequest` declare a salt themselves where the executing account needs one. Each returns a finished `TransactionRequest`, which takes no salt declaration afterwards, so they declare it while they build. A finished request from anywhere else gets the multisig auth args from `withFeeAwareAuth`; see [Executing a request someone else built](#executing-a-request-someone-else-built).

The `client.transactions` operations that build their own request - `send`, `mint`, `consume`, `consumeAll`, `swap`, `bridge`, `withdrawUsdcx`, `createNetworkNote`, `execute`, `pswapCreate`, `pswapConsume`, `pswapCancel`, and the named operations of `batch` and `preview` - declare it too. The ones that take a finished request **from you** never do: `submit`, `executeRequest`, `submitBatch`, and the `custom` operation of `batch` / `preview`. Those are the paths the next two sections are for.

`submitBatch` is worth calling out because a batch proves each transaction as it is pushed, on the client's built-in local prover rather than `proverUrl`. A multisig request that declares no salt is rejected by miden-client during preparation, after the proofs of everything ahead of it in the batch have already been paid for. Build multisig requests from `feeAwareTransactionRequestBuilder`, or pass a finished one through `withFeeAwareAuth`, before batching them.

### Assembling a request yourself

When you build a request from a builder, ask the client for one that already declares a salt where the executing account needs one:

```typescript
const builder = await client.feeAwareTransactionRequestBuilder(wallet);
const request = builder.withCustomScript(script).build();
```

`feeAwareTransactionRequestBuilder` takes the account that will **execute** the request — the one whose auth procedure pays the fee — not the recipient or the note's sender. It is a safe drop-in for `new TransactionRequestBuilder()`: for an account that is not a multisig it returns an untouched builder. A zero base fee is not a second condition — since 0.17 a multisig resolves its auth args whatever the chain charges.

To set the salt yourself — which co-signers must do when they need to agree on it without transporting the proposer's request bytes — declare it directly:

```typescript
import { TransactionRequestBuilder, Word } from "@miden-sdk/miden-sdk";

// Co-signers must all derive the same summary, so they must agree on both the
// salt and the block it binds.
const salt = new Word([1n, 2n, 3n, 4n]);

const request = (
  await client.feeAwareTransactionRequestBuilder(multisig, {
    feeConversionSalt: salt,
    boundBlockNum: agreedBlock,
  })
)
  .withCustomScript(script)
  .build();
```

Each call **consumes** the `Word` you pass: it is moved across the WASM boundary, so a second call needs a freshly built one. Reusing a spent handle is not an error - it arrives as "no salt given" and one is drawn for you, which is the divergence pinning the salt exists to prevent.

The salt is a *declaration*, not a commitment: `request.feeConversionSalt()` reports it back, `request.authArg()` is still empty, and miden-client computes `hash(CONVERSION_INFO || SALT)` from it during preparation. It survives serialization, so a proposal transported to its co-signers still names the salt its summary was derived under.

`withAuthArgs` and `withFeeConversionSalt` are **mutually exclusive**, and miden-client enforces that by having each setter clear the other — so whichever you call last simply wins, rather than producing an error. That makes either setter destructive on a builder from `feeAwareTransactionRequestBuilder` for a multisig: it already carries the component's three-word auth args, and clearing them leaves the auth procedure piping a preimage that was never written. Pass `feeConversionSalt` to the builder instead, as above.

### Executing a request someone else built

A wallet that executes a dApp's finished request from a multisig account cannot use the builder, because the request is already built. If the request declares a salt, it executes as it is: miden-client derives the multisig auth args from the salt, binds them to the reference block of each execution and sets no max fee. If it declares no salt, execution fails with `FeeConversionInfoRequired`. Set the auth args on the request instead:

```typescript
const request = await client.withFeeAwareAuth(dappRequest, multisig);
await client.transactions.submit(multisig, request);
```

`withFeeAwareAuth` returns a copy of the request with the same auth argument and advice-map preimage that `feeAwareTransactionRequestBuilder` declares. The auth args replace a declared fee conversion salt, and every other field stays the same. For an account that is not a multisig the request comes back unchanged, auth argument and all. It takes the same `options` as the builder (`approvalExpirationDelta`, `feeConversionSalt`, `boundBlockNum`, `maxFee`). When `feeConversionSalt` is omitted, it uses the salt that the request declares, or draws a fresh one if the request declares none.

The copy does not declare the bound block as a block number. miden-client adds the bound block when it executes the request, so the request executes at the chain tip. A co-signer cannot read the bound block from `request.blockNumbers()`, so the height check under [Multisig Proposals](#multisig-proposals-bind-a-block-execute-at-the-tip) does not apply to the copy: sync before previewing it.

For a multisig it refuses a request that already has an auth argument, with the error `code` `AUTH_ALREADY_SET` (on Node.js the code prefixes the message). The author of the request owns that argument, so it is not replaced.

#### Setting your own auth args

`withFeeAwareAuth` is built on `request.withAuthArgs(preimage)`, which mirrors miden-client's `TransactionRequest::with_auth_args`. Use it directly when you build the auth args yourself, for example for a custom auth procedure that loads its auth args from the advice map:

```typescript
// `preimage` is a Felt[]: the auth args as the auth procedure reads them.
const request = finishedRequest.withAuthArgs(preimage);
```

It returns a copy whose auth argument is the Poseidon2 hash of `preimage`, with `preimage` in the advice map under that hash, so the auth argument and its preimage always agree. It replaces an existing auth argument and a declared fee conversion salt without a check, and every other field stays the same.

The `Felt`s in `preimage` are consumed by the call in the browser build: they are moved across the WASM boundary, so read what you need from them before the call and pass fresh ones to another call. A spent `Felt` fails with `null pointer passed to rust`.

### Custom auth procedures

miden-client only commits conversion info for auth components it recognises. If you have written your own, which way out applies depends on the procedure:

- **It reads the conversion info from `AUTH_ARGS`** (it calls `fee::load_conversion_info`, like the standard signature components). Attach the auth args yourself with `TransactionRequestBuilder.withAuthArgs`, which sets the commitment and adds its advice-map preimage; on a finished request, `request.withAuthArgs(preimage)` does the same. Setting an auth argument opts the request out of the client's fee machinery entirely — it commits only when the request carries none — so the word you set is the one the procedure reads.
- **It is still yours to write.** Read the chain's native conversion info in the procedure instead, the way the no-auth and network-account components do, and the transaction needs no auth argument at all.

Note that declaring a *salt* against such an account does not work: miden-client rejects a salt whose auth component it cannot see reading it, with `FeeConversionInfoUnsupported` naming the component.

A procedure that calls `fee::pay_fee` passes four inputs, `[num_extra_cycles, CONVERSION_INFO, serial_number_block, initial_nonce]`, and gets two amounts back, `[fee_amount, total_sponsored_fee_amount]`. The standard components pass the reference block number and the account nonce from before the transaction, and the serial number of the fee note is derived from them. A component that was written for the earlier `pay_fee`, which took no nonce and returned one amount, has to be updated.

One request-building path the SDK cannot declare a salt on: `client.pswap.cancelByOrder` resolves the order and builds the request inside miden-client, so the SDK never sees a builder. On a fee-charging chain that leaves the outcome to the creator's auth component — an ordinary creator has its conversion info committed and pays normally, while a multisig creator fails with `FeeConversionInfoRequired`. Cancel by note with `client.transactions.pswapCancel` there, which declares a salt against the creator first.

## Multisig Proposals: Bind a Block, Execute at the Tip

The multisig auth args name a **bound block**, and the transaction summary binds that block rather than the reference block the transaction executes at. A proposal can therefore be verified and submitted at whatever block is current, provided the transaction can authenticate the bound block, and miden-client adds the bound block of multisig auth args to the transaction's partial blockchain when it executes the request. `feeAwareTransactionRequestBuilder` also declares it with `withBlockNumbers`, which only the height check below reads. Each party's client must first have synced to at least the bound block (the largest of `request.blockNumbers()`, by default the proposer's sync height when it built the request); a client below it fails with `requested block N is after transaction reference block M` until it syncs. A request from `withFeeAwareAuth` does not declare the bound block, so sync before previewing it.

Foreign accounts load at the tip, and every fee-paying transaction loads the chain's fee faucet as one. A proposal therefore still executes after the node has pruned the account state of its bound block; a node serves account state for only the last 50 blocks.

The summary also binds a **max fee**. Without one in the auth args, the auth procedure estimates the fee on each execution and the summary binds that estimate. On a chain that charges a fee, set a max fee as shown under [Signing a max fee](#signing-a-max-fee).

```typescript
import { TransactionRequest, TransactionSummary } from "@miden-sdk/miden-sdk";

// ── Proposer ──────────────────────────────────────────────
// The fee-aware builder binds the current sync height and adds it to the
// request's block numbers.
const builder = await client.feeAwareTransactionRequestBuilder(multisig);
const request = builder.withCustomScript(script).build();
const summary = await client.transactions.preview({
  operation: "custom",
  account: multisig,
  request,
});
await shipToCosigners({
  request: request.serialize(),
  summary: summary.serialize(),
});

// ── Co-signer ─────────────────────────────────────────────
// Sync to the tip, which is at or past the bound block, then re-derive from the
// proposer's request bytes.
await client.sync();
const proposedRequest = TransactionRequest.deserialize(requestBytes);
const proposed = TransactionSummary.deserialize(summaryBytes);
const derived = await client.transactions.preview({
  operation: "custom",
  account: multisig,
  request: proposedRequest,
});
if (derived.toCommitment().toHex() !== proposed.toCommitment().toHex()) {
  throw new Error("proposal does not match the summary presented for signing");
}

// ── Executor ──────────────────────────────────────────────
// At the tip, with the collected signatures in the request's advice map.
await client.transactions.submit(multisig, proposedRequest);
```

Notes:

- **The request still travels.** The salt in the multisig auth args is drawn fresh on every build and bound into the summary, so a co-signer must re-derive from the proposer's request bytes.
- **Confirm the bound block is real.** For a multisig, `summary.blockCommitment()` is the bound block's commitment and `summary.blockNum()` is its number. Fetch that block's header from a node you trust (`RpcClient.getBlockHeaderByNumber`) and compare commitments.
- **Approvals can expire.** `approvalExpirationDelta` on `feeAwareTransactionRequestBuilder` counts from the bound block, and the multisig rejects execution at or after that reference block. Omitted, the approval does not expire.
- **The fee note is not in the summary.** A multisig pays the fee after it has checked the signatures, so `summary.outputNotes()` does not include the fee note. The approvers sign the max fee instead, which is `summary.userParams()[1]`. The fee note is in the output notes of the executed transaction.
- **A preview does not reach the fee payment.** An unsigned execution stops at the signature check. A fee that the account cannot pay therefore fails only the signed execution.
- **A match still does not prove agreement on account state.** Everything under [What a Summary Proves](#what-a-summary-proves) applies.

Available from `0.17.0-rc.4`.

### Signing a max fee

The fee of a transaction is known only when the transaction executes, so the approvers of a multisig sign a cap. The summary binds that max fee, and the signed transaction pays any fee up to it.

Without a max fee in the auth args, the auth procedure estimates the fee on each execution and the summary binds the estimate. The estimate depends on the verification base fee of the reference block and on the cycle count of the transaction. An execution at a later block then reproduces the summary only while the estimate comes out the same: if the base fee of the chain changes between the preview and the execution, the summary changes and the collected signatures no longer match it.

`client.withEstimatedMaxFee` turns the estimate of one preview into a cap:

```typescript
// ── Proposer ──────────────────────────────────────────────
const draft = (await client.feeAwareTransactionRequestBuilder(multisig))
  .withCustomScript(script)
  .build();
const estimated = await client.transactions.preview({
  operation: "custom",
  account: multisig,
  request: draft,
});

// The max fee is the estimate plus 50%.
const { request, summary, maxFee } = await client.withEstimatedMaxFee(
  draft,
  estimated,
  { feeMarginPercent: 150 }
);
await shipToCosigners({
  request: request.serialize(),
  summary: summary.serialize(),
});
```

- **Ship what it returns.** The approvers sign the returned `summary`, and the executor submits the returned `request`. Executing that request reproduces that summary, so the proposer needs no second preview. The co-signer and executor steps above stay the same.
- **`feeMarginPercent` is required.** 100 keeps the estimate, and 150 adds half of it. The result is rounded up.
- **A zero estimate yields no cap.** A max fee of zero means that the auth procedure estimates the fee. On a chain that charges no fee the estimate is zero, so the returned request and summary equal the ones passed in.
- **The request must carry multisig auth args.** `feeAwareTransactionRequestBuilder` and `withFeeAwareAuth` set them for a multisig account. Any other request is refused with the error `code` `AUTH_ARGS_NOT_MULTISIG` (on Node.js the code prefixes the message).
- **The summary must be the preview of that request.** A summary that binds another salt, bound block or approval expiration is refused.
- **A fee above the max fee fails the signed execution**, not the preview.

To set a cap that you already know, pass `maxFee` to the builder or to `withFeeAwareAuth`. It joins the salt and the bound block as a value that a co-signer needs to reproduce a proposal:

```typescript
const request = (
  await client.feeAwareTransactionRequestBuilder(multisig, {
    feeConversionSalt: salt,
    boundBlockNum: agreedBlock,
    maxFee: 5000n,
  })
)
  .withCustomScript(script)
  .build();
```

The `client.transactions` operations that build their own request, such as `send` and `consume`, and the `new*TransactionRequest` constructors set no max fee.

`maxFee` and `withEstimatedMaxFee` are available from `0.19.0`.

## Summaries That Bind the Reference Block

A single-signature (`signature.masm`) account's summary binds the **reference block** commitment: a signature over that summary authorizes only an execution whose reference block is the one the summary was built at.

A transaction always executes at the sync height of the client, and nothing pins another reference block. Such a summary therefore reproduces only at the sync height it was derived at:

- A sync between deriving the summary and executing moves the reference block, and the signature no longer authorizes the execution.
- A client at another sync height derives a different summary from the same request.

For signatures that are collected over time or on other clients, use a multisig account and the flow in the previous section. Its summary does not bind the reference block.

`ChainAnchor`, `transactions.captureAnchor` and the `anchor` option of `preview`, `executeRequest` and `submit` pinned the reference block in earlier versions. They were removed in `0.19.0`.

## What a Summary Proves

These notes apply to every flow that compares or signs a transaction summary.

- **The request travels.** A co-signer has to re-derive the summary from the proposer's request bytes, not from a request they build themselves. A multisig request carries auth args whose salt is drawn fresh on every build, and the multisig auth procedure uses that salt as the summary's replay guard — so two independently built requests produce two different summaries even when they describe the identical transfer. Rebuilding locally therefore fails the comparison and reads as tampering when nothing is wrong. `TransactionRequest.serialize()` / `.deserialize()` are the transport. To check that a received request equals one you hold, use `request.equals(other)`, not a byte comparison: bytes that list the same fields or Merkle store nodes in another order decode to an equal request, so equal requests can differ in bytes.

- **Signature collection is a separate concern.** Signatures are returned to the executor and attached to the request with `request.extendAdviceMap(...)` before submission.

- **What the summary actually covers.** The signed commitment is built from exactly seven things: the account delta, the input-note commitment, the output-note commitment, the reference block commitment (the bound block, for a multisig), the logs commitment, the expiration delta, and the user params. The transaction script root, the advice map, note arguments and foreign-account inputs are **not** among them. Two different requests that produce the same delta and the same note sets therefore produce the same commitment, and one set of signatures authorizes both. Do not rely on "a different request would be rejected" — it would not be. Accounts that need the script itself bound should use the transaction-script allowlist component from `miden-standards`.
- **A co-signer must already track the account.** Verification runs a real execution, so the account has to exist in that participant's local store: a public account can be pulled in with `accounts.getOrImport`, but a private account requires its state to be transferred out of band. Without it, `preview` fails to find the account rather than returning a mismatch.

- **Re-deriving a summary proves consistency, not intent.** When a proposer sends you a request and a summary, both come from them. Re-deriving the summary and comparing `toCommitment()` proves only that the two agree with each other — which they will, for any request the proposer chose, including one that drains the account. The check catches a corrupted or substituted *component*; it says nothing about what the transaction does.

  Before signing, inspect the effects: `summary.accountDelta()`, `summary.inputNotes()`, `summary.outputNotes()`, `summary.logs()` and `summary.expirationDelta()`, and confirm they are what you meant to approve. For storage, `summary.accountDelta().storage()` names each changed slot: `valueSlots()` gives a value slot's `slotName`, `operation` and final `value`, and `mapSlots()` gives a map slot's `slotName`, `operation` and changed `entries()` (`key`, `value`), so a change to a multisig's signer set or threshold is visible before you sign.
- **Account state comes from each participant's own store.** So do authenticated input notes, and all parties must agree on the account state too. If the account moved in a way that changes the transaction's effects, the re-derived summary will not match - the most common reason a co-signing flow fails.

  **A match does not mean the two parties agree on account state.** The summary binds the account *delta* — the change — not the state it applies to. Divergence that leaves the delta and the note sets identical produces a byte-identical commitment and passes verification: an unrelated nonce bump, assets arriving, or, for a multisig, a change to the signer set or threshold. That last one matters most, because signatures gathered under one threshold remain valid after it is lowered. A `signature.masm` account additionally binds the final nonce as `summary.userParams()[0]`, which does pin the absolute pre-state; a multisig does not bind the nonce, because its user params hold the approval expiration, the max fee and the salt. Check whatever state you actually care about — nonce, signer set, threshold, balances — directly, rather than inferring it from a matching summary.
- **`expirationDelta()` returns 0 to mean no expiration was set**, not that the transaction expires immediately. A transaction that sets an expiration expires that many blocks after its reference block, which is the sync height of the executing client.
