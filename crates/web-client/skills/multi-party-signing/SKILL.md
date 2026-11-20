---
name: multi-party-signing
description: Rules for multi-party signing flows, where one party signs a transaction summary and another party executes the transaction. Multisig proposals bind a block in their auth args and execute at the tip; a summary that binds the reference block reproduces only at the same sync height. Use when writing or reviewing multisig proposal, co-signing or submission code, when a wallet executes a finished request from a multisig with withFeeAwareAuth, when a multisig proposal fails with `requested block N is after transaction reference block M`, when building a request that travels between parties with withExplicitInputNote or withForeignAccounts, when using preview or usePreview, or when debugging summary commitments that never match between co-signers, OPERATION_BUSY, STALE_CLIENT, TRANSACTION_ALREADY_AUTHORIZED, AUTH_ALREADY_SET or FeeConversionInfoRequired.
---

# Multi-Party Signing

**Availability:** `usePreview` arrived in `@miden-sdk/react` `0.16.0-rc.3`;
`transactions.preview` is older. `withExplicitInputNote` (R3) arrived in
`0.16.1`. `withBlockNumbers` and tip execution of multisig proposals (§1, R0)
arrived in `0.17.0-rc.4`. `withFeeAwareAuth`, `TransactionRequest.withAuthArgs`,
and tip execution of a multisig request that does not declare its bound block
arrived in `0.17.4`. The `maxFee` option and `withEstimatedMaxFee` (R0) arrived in
`0.19.0`.
This skill ships inside the package, so if you are reading it from
`node_modules/@miden-sdk/miden-sdk/skills/`, the installed version has these
surfaces. If a symbol is missing anyway, you are on a build older than the release
that added it; upgrade rather than working around it.

**Removed in `0.19.0`:** `ChainAnchor`, `transactions.captureAnchor`, the `anchor`
option of `preview` / `executeRequest` / `submit`, `useChainAnchor`, and the
`INVALID_CHAIN_ANCHOR` code. A transaction always executes at the sync height of
the client. Code that pinned a reference block for a multisig moves to R0. For
a single-signature summary, see R1.

Source of truth: [web-sdk#348](https://github.com/0xMiden/web-sdk/pull/348) (fees)
and [#383](https://github.com/0xMiden/web-sdk/pull/383) (determinism).

---

## 1. First, decide whether this applies

Apply this test:

> Will a signature be collected over a transaction summary by one party, and the
> transaction executed later or by a different party?

- **No** → nothing in this document applies to you. The account signs during the
  execution, at the current tip.
- **Yes, and the executing account is a multisig** → follow R0: bind a block, and
  let every party execute at its own tip.
- **Yes, and the summary binds the reference block** (a single-signature
  `signature.masm` account) → read R1: the summary reproduces only at the
  same sync height.

**Why:** a single-signature summary binds the reference block commitment
(`auth::create_tx_summary`), so a signature authorizes execution **only at that exact
block**. Since protocol 0.17 a multisig summary binds instead the **bound block** named
in its auth args (`auth::create_tx_summary_with_block`), which any later reference
block can authenticate once it is in the transaction's partial blockchain.

### R0 - A multisig proposal executes at the tip

Build the request with `client.feeAwareTransactionRequestBuilder(account)`. For a
multisig it binds the current sync height as the bound block in its auth args, and
miden-client tracks that block when it executes the request, so the proposer, every
co-signer and the executor can call `preview` / `submit`, each at its own tip, and
derive the same summary while the fee estimate described below stays the same. The
builder also adds the bound block with
`withBlockNumbers`; only the height check below reads that declaration. Each party's
client must first have synced to at least the bound block (the largest of
`request.blockNumbers()`, by default the proposer's sync height when it built the
request). A client below it fails with `requested block N is after transaction
reference block M` until it syncs.

A finished request that another party built, such as a dApp's request handed to a
wallet, gets the same auth args from `await client.withFeeAwareAuth(request, account)`.
The copy does not declare the bound block, so `request.blockNumbers()` cannot drive the
height check: sync before previewing it, and sync again on `requested block N is after
transaction reference block M`. For a multisig it refuses a request that already has an
auth argument (`AUTH_ALREADY_SET`); any other account's request comes back unchanged.

Foreign accounts, the chain's fee faucet among them, load at the tip. A proposal
therefore still executes after the node has pruned the account state of its bound
block (a node keeps account state for 50 blocks).

The summary also binds a **max fee**, the fee cap that the approvers sign. Without
one in the auth args, the auth procedure estimates the fee on each execution and the
summary binds that estimate. The estimate depends on the verification base fee of the
reference block and on the cycle count of the transaction. The parties then derive the
same summary at different tips only while the estimate comes out the same. If the base
fee of the chain changes between the preview and the execution, the summary changes
and the collected signatures no longer match it.

On a chain that charges a fee, sign a cap. Preview the request once, then pass the
request and the summary to `client.withEstimatedMaxFee`:

```js
const draft = (await client.feeAwareTransactionRequestBuilder(multisig))
  .withCustomScript(script)
  .build();
const estimated = await client.transactions.preview({
  operation: "custom",
  account: multisig,
  request: draft,
});

// The max fee is the estimate plus 50%.
const { request, summary } = await client.withEstimatedMaxFee(draft, estimated, {
  feeMarginPercent: 150,
});
// Ship `request.serialize()` and `summary.serialize()`.
```

- The approvers sign the returned `summary`, and the executor submits the returned
  `request`. Do not ship `draft` or `estimated`.
- Executing the returned request reproduces the returned summary, so the proposer needs
  no second preview.
- `feeMarginPercent` is required: 100 keeps the estimate, and 150 adds half of it.
- A max fee of zero means that the auth procedure estimates the fee. On a chain that
  charges no fee the estimate is zero, and the helper returns an equal request and
  summary.
- To set a cap that you already know, pass `maxFee` in the options of
  `feeAwareTransactionRequestBuilder` or `withFeeAwareAuth`. A co-signer that rebuilds
  a proposal pins it together with `feeConversionSalt` and `boundBlockNum`.
- `send`, `consume` and the other `client.transactions` operations that build their
  own request set no max fee.

R2's request transport still applies: co-signers must re-derive from the proposer's
request bytes, because the salt in the auth args is drawn fresh per build.

Check the bound block is real by comparing `summary.blockCommitment()` with the header
a trusted node returns for `summary.blockNum()`:

```js
import { RpcClient } from "@miden-sdk/miden-sdk";

const rpc = new RpcClient(endpoint);
const real = await rpc.getBlockHeaderByNumber(summary.blockNum());
if (real.commitment().toHex() !== summary.blockCommitment().toHex()) {
  throw new Error("the proposal does not bind a block on this chain");
}
```

---

## 2. Rules

Each rule states what to do, then why. Follow them literally.

### R1 - A summary that binds the reference block reproduces only at the same sync height

A transaction executes at the sync height of the client, and nothing can pin another
reference block. A signature over a summary that binds the reference block therefore
authorizes an execution only while the executing client is at the sync height the
summary was derived at.

- A sync between deriving the summary and executing moves the reference block, and
  the signature no longer authorizes the execution.
- In React, `useTransaction().execute` syncs before it executes unless `skipSync` is
  set, and `MidenProvider` syncs on its `autoSyncInterval`.
- A client at another sync height derives a different summary from the same request.

Do not build a flow that collects such a signature over time or on another client.
Use a multisig account (R0): its summary does not bind the reference block.

### R2 - A co-signer re-derives from the proposer's request bytes

Never re-resolve a request factory or re-run a builder to get "the same" request.
Calling it again returns a different object, and two draws from the client's RNG make
that object differ each time: any builder that creates an output note takes a fresh
serial number, and a multisig request takes a fresh salt in its auth args. The second
reaches **every** multisig request, including a custom-script one with no output
notes at all, and the auth procedure reuses the salt as the summary's replay guard.
Two independently built requests therefore yield two different summaries even when
they describe the identical transfer.

Ship `request.serialize()` alongside the summary, and rebuild with
`TransactionRequest.deserialize(bytes)`. In React, resolve the request once and pass
that one object to `preview` and to `execute`:

```tsx
// CORRECT - one resolved object reaches both calls
const request = await buildRequest(client);
const summary = await preview({ accountId, request });
// ... collect signatures ...
await execute({ accountId, request });

// WRONG - buildRequest resolves to a different transaction each time
await preview({ accountId, request: buildRequest });
await execute({ accountId, request: buildRequest });
```

Verification runs a real execution, so the co-signer's local store must already
hold the account. Pull a public account in with `accounts.getOrImport`; a private
account needs its state transferred out of band. Without it, `preview` fails to
find the account rather than returning a mismatch.

### R3 - Pin how input notes are consumed on any request that travels

`withInputNotes` leaves the mode to the executing client: authenticated if that
client's store holds the note's inclusion proof, unauthenticated otherwise. Two
co-signers with different stores therefore derive different summaries from the same
request, and the comparison fails with nothing visibly wrong.

`withExplicitInputNote(note, args?)` pins the mode on the request itself. Each note
is consumed in the mode its `InputNote` carries, whatever the executing client
holds:

```ts
import { InputNote, TransactionRequestBuilder } from "@miden-sdk/miden-sdk";

const request = new TransactionRequestBuilder()
  // Consumed with its proof and optional arguments.
  .withExplicitInputNote(InputNote.authenticated(note, inclusionProof), args)
  // Consumed as unauthenticated, even if the executing client has a proof.
  .withExplicitInputNote(InputNote.unauthenticated(otherNote))
  .build();
```

One note per call; omit the second argument or pass `null` for no note args. The
`InputNote` stays usable after the call. To consume an authenticated note, the
executing client must be able to serve the header of the note's creation block.

### R4 - Foreign accounts are read at the tip

A transaction that calls into a foreign account fetches that account's state at
execution time, from the node, at the reference block, which is the sync height of
the executing client. On a fee-charging chain every transaction loads the fee
faucet this way, so this applies even to a request that declares no foreign
account. A node serves account state for a limited window (50 blocks at the time of
writing), so a client that is far behind the tip must sync before it executes.

```ts
const request = builder
  .withForeignAccounts([ForeignAccount.public(targetId, storageRequirements)])
  .build();
```

Two things to get right:

- **Only the accounts you name are declared.** This does not discover accounts the
  transaction loads on its own, such as a faucet whose asset callback it triggers.
- **`ForeignAccount.public(id, requirements)` is fetched from the network** and
  `ForeignAccount.private(account)` contributes its own state and fetches only an
  inclusion proof.

A foreign account's vault entries and storage-map keys are resolved during
execution. `foreignAccountInputs`, `ForeignAccount.prefetched` and `AccountInputs`
were removed in 0.17, so the state cannot travel with the request.

### R5 - Budget for main-thread blocking

`preview` runs in WASM on the main thread, not the worker. It blocks the UI for its
duration and queues other client calls behind it. Disable the triggering control
while `isPreviewing` is true.

`useTransaction().execute` is offloaded to the worker as usual.

### R6 - Import the class, not the type, to deserialize in React

`@miden-sdk/react` re-exports `TransactionRequest` and `TransactionSummary` as
**types only**, and does not re-export `InputNote` or `ForeignAccount` at all.
Calling a static such as `TransactionRequest.deserialize(bytes)` requires importing
the class from `@miden-sdk/miden-sdk` directly.

---

## 3. Failure modes → cause

Map an observed symptom to its cause before proposing a fix.

| Symptom | Cause |
| --- | --- |
| Co-signer's summary never matches the proposer's | The request was re-resolved instead of transported (R2). For a summary that binds the reference block: the two clients are at different sync heights (R1) |
| Co-signers' summaries differ and every other check passes | The request used `withInputNotes`, so each client chose the consumption mode from its own store. Rebuild with `withExplicitInputNote` (R3) |
| A signature over a single-signature summary does not authorize the execution | The client synced between `preview` and the execution, so the reference block moved (R1) |
| `FeeConversionInfoRequired` naming the auth component | The executing account is a multisig and the request declares no fee conversion salt. Build it from `await client.feeAwareTransactionRequestBuilder(account)` rather than a bare `TransactionRequestBuilder`, or add the auth args to a finished request you did not build with `await client.withFeeAwareAuth(request, account)` (R0) |
| `FeeConversionInfoUnsupported` naming the auth component | A salt was declared against an auth component that never reads it. Drop the salt, or attach the auth args with `withAuthArgs`, or `request.withAuthArgs(preimage)` on a finished request |
| `ERR_FEE_CONVERSION_INFO_MISSING` aborting in the VM | A custom auth procedure reads conversion info that nothing committed. Attach it yourself with `withAuthArgs`, or `request.withAuthArgs(preimage)` on a finished request |
| `AUTH_ALREADY_SET` from `withFeeAwareAuth` | The executing account is a multisig and the request already carries an auth argument. Its author owns that argument, so `withFeeAwareAuth` does not replace it (R0) |
| `AUTH_ARGS_NOT_MULTISIG` from `withEstimatedMaxFee` | The request has no auth argument, or its auth args are not multisig auth args. Build it from `feeAwareTransactionRequestBuilder`, or pass it through `withFeeAwareAuth`, for a multisig account (R0) |
| `the summary does not belong to the request` from `withEstimatedMaxFee` | The summary binds another salt, bound block or approval expiration than the auth args of the request. Pass the summary from the preview of that same request (R0) |
| A signed multisig transaction aborts in the fee payment, and a development build reports `the transaction fee and the sponsored fees exceed the max fee` | The fee at execution is above the cap that the approvers signed. Preview again and sign a new cap with a larger `feeMarginPercent` (R0) |
| `preview` fails to find the account on the co-signer | Verification runs a real execution, so the account must already be in that participant's store. `accounts.getOrImport` for a public account; a private one needs its state transferred out of band (R2) |
| Execution fails naming a foreign account and a block | The client is behind the node's account-history window. Sync, then retry (R4) |
| `requested block N is after transaction reference block M` | A multisig proposal previewed or submitted on a client whose sync height M is still below its bound block N. Sync, then retry (R0) |
| `OPERATION_BUSY` | A preview is already running. Await the previous one |
| `STALE_CLIENT` | The client was swapped mid-call. Derive the summary again on the new chain |
| `TRANSACTION_ALREADY_AUTHORIZED` from `preview` | Nothing is awaiting authorization. Submit with `useTransaction` instead |
| `captureAnchor is not a function`, or `ChainAnchor` is undefined | The code targets an SDK before `0.19.0`. Anchored execution was removed: move a multisig to R0, and see R1 for a single-signature flow |

**Node.js note:** codes originating in the client (`TRANSACTION_ALREADY_AUTHORIZED`,
`AUTH_ALREADY_SET`, `AUTH_ARGS_NOT_MULTISIG`) **prefix the message** instead of appearing as a property, because
the napi bindings cannot attach one. Codes originating in the React package
(`OPERATION_BUSY`, `STALE_CLIENT`) are always properties. Write error handling that
tolerates both shapes.

---

## 4. Semantics you will otherwise get wrong

- **`expirationDelta()` returning 0 means no expiration was set.** It does not mean the
  transaction has expired. Do not write a check that treats 0 as expired.
- **A matching summary proves agreement, not intent.** The commitment is built from
  exactly seven things: the account delta, the input-note commitment, the output-note
  commitment, the reference block commitment (the bound block, for a multisig), the
  logs commitment, the expiration delta and the user params. The transaction script root, the advice map, note arguments and
  foreign-account inputs are **not** among them. Two different requests that produce
  the same delta and the same note sets therefore produce the same commitment, and one
  set of signatures authorizes both. Do not rely on "a different request would be
  rejected", because it would not be. An account that needs the script itself bound
  should use the transaction-script allowlist component from `miden-standards`.
- **A matching summary does not mean both parties agree on account state.** The
  commitment binds the account _delta_, the change, not the state it applies to.
  Divergence that leaves the delta and the note sets identical produces a
  byte-identical commitment and passes verification: an unrelated nonce bump, assets
  arriving, or, for a multisig, a change to the signer set or threshold. That last one
  matters most, because signatures gathered under one threshold remain valid after it
  is lowered. A `signature.masm` account additionally binds the final nonce as
  `summary.userParams()[0]`. A multisig does not bind the nonce: its user params hold
  the approval expiration, the max fee and the salt. Check the state you care about
  directly rather than inferring it from a matching summary.
- **A single-signature summary includes the fee note, and a multisig summary does
  not.** This applies on any chain whose verification base fee is non-zero.
  - A `signature.masm` account pays the fee before it builds the summary, so
    `summary.outputNotes()` includes the fee note. `TransactionSummary` has no
    `userOutputNotes()` / `feeNote()` split, unlike `ExecutedTransaction`. Label the fee
    note in a confirmation UI rather than presenting it as one of the user's own, and
    do not assume `outputNotes()[0]` is the note they asked for.
  - A multisig pays the fee after it has checked the signatures, so its summary has no
    fee note. The approvers sign the max fee instead, which is
    `summary.userParams()[1]`. Show that value in a confirmation UI.
- **A multisig preview does not reach the fee payment.** An unsigned execution stops
  at the signature check. A fee that the account cannot pay therefore fails only the
  signed execution, not the preview.
- **`preview` only yields a summary while authorization is pending.** The summary is
  produced when the account's auth procedure aborts with the unauthorized event, e.g. a
  multisig below its signing threshold. A fully authorized transaction produces no
  summary and rejects with `TRANSACTION_ALREADY_AUTHORIZED`.
- **A summary is chain-bound.** `usePreview` clears its state on client change for this
  reason. Account records and authenticated input notes come from each participant's
  own store, so the parties must agree on account state too.

---

## 5. API reference

### Core client - `client.transactions`

```ts
preview({ operation: "custom", account, request })
executeRequest(account, request)
submit(account, request, txOptions?)
```

All three execute at the current sync height.

`client.feeAwareTransactionRequestBuilder(account)` returns a
`TransactionRequestBuilder` that already declares a fee conversion salt where the
executing account needs one. It is a safe drop-in for `new
TransactionRequestBuilder()`: for an account that is not a multisig the builder
comes back untouched. A zero base fee is not a second condition: since 0.17 a
multisig resolves its auth args whatever the chain charges.

`client.withFeeAwareAuth(request, account, options?)` returns a copy of a finished
request with the auth args that builder would set, and returns any other account's
request unchanged. The copy does not declare the bound block (R0).

Both take the multisig-only `options` `approvalExpirationDelta`, `feeConversionSalt`,
`boundBlockNum` and `maxFee` (a `bigint` or an integer `number`, in the native fee
asset).

`client.withEstimatedMaxFee(request, summary, { feeMarginPercent })` returns
`{ request, summary, maxFee }`: the request with the max fee in its multisig auth args,
the summary to sign, and the max fee as a `bigint` (R0). The binding behind it is
`request.withEstimatedMaxFee(summary, feeMarginPercent)`, which returns an
`EstimatedMaxFee` with `request()`, `summary()` and `maxFee()`.
`request.withAuthArgs(preimage)` sets auth args you build yourself on a finished
request; in the browser build it consumes the `Felt`s it is given.

### `TransactionSummary`

| Member | Returns | Purpose |
| --- | --- | --- |
| `toCommitment()` | `Word` | The value co-signers compare and sign over |
| `blockCommitment()` | `Word` | Commitment of the block the summary binds: the bound block for a multisig, the reference block otherwise |
| `blockNum()` | `u32` | Number of that block |
| `expirationDelta()` | `u16` | 0 means no expiration was set, not expired |
| `accountDelta()` | `AccountDelta` | Inspect before signing; `.storage().valueSlots()` / `.mapSlots()` name the changed slots and map entries |
| `inputNotes()` / `outputNotes()` | `InputNotes` / `OutputNotes` | Inspect before signing; `outputNotes()` includes the fee note for a `signature.masm` account, and not for a multisig |
| `userParams()` | `Felt[]` | Six elements; `signature.masm` puts the final nonce in `[0]`; a multisig puts the approval expiration in `[0]`, the max fee in `[1]` and the salt in the other four |
| `logs()` | `TransactionLogs` | The logs the transaction emitted, bound by the summary commitment; its `logs()` returns each `TransactionLog` (`emitter()`, `topicPrefix()`, `topicSuffix()`, `content()`) |
| `serialize()` / `TransactionSummary.deserialize(bytes)` | bytes / `TransactionSummary` | Transport |

### Determinism helpers for a request that travels

```ts
new TransactionRequestBuilder()
  .withBlockNumbers([boundBlock])            // blocks the tx must authenticate (R0)
  .withExplicitInputNote(inputNote, args?)   // pins authenticated vs unauthenticated
  .withForeignAccounts([foreignAccount])     // declared foreign accounts, read at the reference block

InputNote.authenticated(note, inclusionProof)
InputNote.unauthenticated(note)

ForeignAccount.public(id, storageRequirements)
ForeignAccount.private(account)
```

### React

```ts
usePreview()     // { preview, summary, isPreviewing, error, reset }
useTransaction() // execute({ accountId, request, skipSync? })
```

---

## 6. Reference implementation

### Multisig (R0)

```ts
import { TransactionRequest } from "@miden-sdk/miden-sdk";

// Proposer: the fee-aware builder binds the sync height and adds it to the block numbers.
const request = (await client.feeAwareTransactionRequestBuilder(account))
  .withCustomScript(script)
  .build();
const summary = await client.transactions.preview({ operation: "custom", account, request });
ship(request.serialize(), summary.serialize());

// Co-signer: sync to the tip (at or past the bound block), then re-derive from the proposer's bytes.
await client.sync();
const proposedRequest = TransactionRequest.deserialize(requestBytes);
const derived = await client.transactions.preview({
  operation: "custom", account, request: proposedRequest,
});
if (derived.toCommitment().toHex() === expected.toCommitment().toHex()) {
  sign(derived);
}

// Executor: at the tip.
await client.transactions.submit(account, proposedRequest);
```

React:

```tsx
function ProposeButton({ accountId, buildRequest }: Props) {
  const { client } = useMiden();
  const { preview, isPreviewing } = usePreview();

  const propose = async () => {
    // Resolve the factory here, once, and ship these bytes (R2).
    const request = await buildRequest(client);
    const summary = await preview({ accountId, request });
    await shipToCosigners(request.serialize(), summary.serialize());
  };

  return <button onClick={propose} disabled={isPreviewing}>Propose</button>;
}
```

---

## 7. Pre-ship checklist

Before considering multi-party signing work complete, confirm each of these:

- [ ] A multisig proposal is built with `feeAwareTransactionRequestBuilder` (or, as a
      finished request, gets its auth args from `withFeeAwareAuth`) and every party
      syncs to its bound block before `preview` or `submit` (R0).
- [ ] On a chain that charges a fee, a multisig proposal carries a max fee, from
      `withEstimatedMaxFee` or the `maxFee` option, and the approvers sign the summary
      that binds it (R0).
- [ ] No flow depends on a summary that binds the reference block reproducing at
      another sync height (R1).
- [ ] The verifying side uses the proposer's request bytes, not a rebuild, and already
      tracks the account (R2).
- [ ] In React, one resolved request object reaches `preview` and `execute`, not a
      factory passed twice (R2).
- [ ] Any request that travels pins its input-note modes with `withExplicitInputNote`
      (R3).
- [ ] The bound block of a proposal from an untrusted party is checked against a
      trusted node (R0).
- [ ] Controls are disabled while `isPreviewing` (R5).
- [ ] Error handling covers both the property and message-prefix shapes of client
      codes (§3).
- [ ] No check treats `expirationDelta() === 0` as expired (§4).
- [ ] A confirmation UI labels the fee note in the `summary.outputNotes()` of a
      single-signature account rather than presenting it as one of the user's own, and
      shows the max fee of a multisig summary (§4).
