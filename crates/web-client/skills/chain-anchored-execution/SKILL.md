---
name: chain-anchored-execution
description: Rules for using ChainAnchor to pin transaction execution to a specific block, required whenever a signature is collected over a transaction summary by one party and the transaction is executed later or by another party, as in multisig proposals and offline co-signing. Use when writing or reviewing code that calls captureAnchor, preview, executeRequest or submit with an anchor, builds a request that travels between parties with withExplicitInputNote or withForeignAccounts, uses useChainAnchor or usePreview, or when debugging summary commitments that never match between co-signers, INVALID_CHAIN_ANCHOR, OPERATION_BUSY, STALE_CLIENT, TRANSACTION_ALREADY_AUTHORIZED or FeeConversionInfoRequired.
---

# Chain-Anchored Execution

**Availability:** `@miden-sdk/miden-sdk` and `@miden-sdk/react` from `0.16.0-rc.3`,
and in every release since. `withExplicitInputNote` (R3) and foreign-account
prefetching, removed again in `0.17.0` (R4), arrived in `0.16.1`.
This skill ships inside the package, so if you are reading it from
`node_modules/@miden-sdk/miden-sdk/skills/`, the installed version has these
surfaces. If a symbol is missing anyway, you are on a build older than the release
that added it; upgrade rather than working around it.

Source of truth: [web-sdk#301](https://github.com/0xMiden/web-sdk/pull/301)
(anchors), [#348](https://github.com/0xMiden/web-sdk/pull/348) (fees) and
[#383](https://github.com/0xMiden/web-sdk/pull/383) (determinism).

---

## 1. First, decide whether this applies

Do **not** reach for `ChainAnchor` by default. Apply this test:

> Will a signature be collected over a transaction summary by one party, and the
> transaction executed later or by a different party?

- **No** → omit `anchor` entirely. Execution runs at the current tip, exactly as
  before. Nothing in this document applies to you.
- **Yes** → you need an anchor. Multisig proposals and offline co-signing are the
  canonical cases.

**Why:** since protocol 0.16 a signed transaction summary binds the reference block
commitment, so a signature authorizes execution **only at that exact block**. Without
an anchor, each party re-executing at their own sync height derives a different summary
and verification can never succeed.

---

## 2. Rules

Each rule states what to do, then why. Follow them literally.

### R1 - Execute the exact request object the anchor was captured for

Never re-resolve a request factory or re-run a builder after capturing. Calling it
again returns a different object, and two draws from the client's RNG make that
object differ each time: any builder that creates an output note takes a fresh
serial number, and on a fee-charging chain the fee conversion info takes a fresh
salt. The second reaches **every** request, including a custom-script one with no
output notes at all. The result is a materially different transaction that the
anchor does not pin and the co-signers did not approve.

In React, resolve the request yourself and pass that one object to every call.
`useChainAnchor()` also returns `anchoredRequest`, but it is React state: inside
the handler that just captured, it still holds the previous render's value, which
is `null` on a first capture. It is the right value one render later, when you
show the summary and execute on a second interaction.

```tsx
// CORRECT - one resolved object reaches all three calls
const request = await buildRequest(client);
const anchor = await captureAnchor({ request });
await preview({ accountId, request, anchor });

// WRONG - `anchoredRequest` is state, so it is still null here
const anchor = await captureAnchor({ request: buildRequest });
await preview({ accountId, request: anchoredRequest!, anchor });

// WRONG - buildRequest resolves to a different transaction
const anchor = await captureAnchor({ request: buildRequest });
await preview({ accountId, request: buildRequest, anchor });
```

### R2 - A verifying co-signer must pass the proposer's anchor to `preview`

Omitting it derives the summary at the local sync height, producing a different
commitment every time. The comparison then fails permanently and looks like a
verification bug.

The co-signer also needs the proposer's **request bytes**, not a request they build
themselves. A multisig request's fee conversion salt is drawn fresh on every build
and the auth procedure reuses it as the summary's replay guard, so two
independently built requests yield two different summaries even when they describe
the identical transfer. Ship `request.serialize()` alongside the anchor and the
summary, and rebuild with `TransactionRequest.deserialize(bytes)`.

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
executing client must be able to serve the header of the note's creation block,
from its own store or from the anchor the request executes against.

Available from `0.16.1`.

### R4 - A foreign account forces a recent anchor

A transaction that calls into a foreign account fetches that account's state at
execution time, from the node, at the reference block. An anchored flow executes at
an older block, and a node stops serving account state past a limited window (50
blocks at the time of writing), so a proposal that sat awaiting signatures fails at
execution, naming the account and the block.

Until 0.16 the state could be fetched at the anchor's block and shipped with the
proposal. 0.17 removed that path along with the upstream types behind it -
`foreignAccountInputs`, `ForeignAccount.prefetched` and `AccountInputs` are gone,
and a foreign account's vault entries and storage-map keys are resolved during
execution instead. So for a request that calls into a foreign account, the anchor
must stay inside the node's account-history window: capture it close to execution,
and re-capture rather than reuse one that has aged out.

```ts
const request = builder
  .withForeignAccounts([ForeignAccount.public(targetId, storageRequirements)])
  .build();
const anchor = await client.transactions.captureAnchor(request);
// collect signatures, then execute promptly against `anchor`
```

Two things to get right:

- **Only the accounts you name are declared.** This does not discover accounts the
  transaction loads on its own, such as a faucet whose asset callback it triggers.
- **`ForeignAccount.public(id, requirements)` is fetched from the network** and
  `ForeignAccount.private(account)` contributes its own state and fetches only an
  inclusion proof.

### R5 - Validate an anchor that arrives from an untrusted party

Malformed anchors are impossible: the chain-length and peak-hash invariants are
enforced natively on construction and on `deserialize`, and trailing bytes are
rejected. What remains possible is an anchor pinned to the **wrong** block, or to a
block that never existed.

1. Compare `anchor.commitment()` against `summary.blockCommitment()`.
2. Stronger: re-derive the summary at the anchor and compare `toCommitment()`, which
   also binds the request and the local account state.
3. Neither detects a **fabricated** block: both invariants hold over an entirely
   invented chain. The check is one call, so make it a standard step.

```js
import { RpcClient } from "@miden-sdk/miden-sdk";

const rpc = new RpcClient(endpoint);
const real = await rpc.getBlockHeaderByNumber(received.blockNum());
if (real.commitment().toHex() !== received.commitment().toHex()) {
  throw new Error("anchor does not name a block on this chain");
}
```

Do not escalate a fabricated-block risk beyond its actual severity: such a
transaction cannot be submitted and its signature cannot be moved onto a real one,
so the cost is a wasted proof and a misleading preview rather than funds. The
header does, however, supply the block number, timestamp and fee parameters
execution runs against, which is why the check is worth making anyway.

### R6 - Free anchors in repeated-capture flows

An anchor carries a partial blockchain. Call `anchor.free()` when done rather than
waiting for the finalizer.

React's `reset()` deliberately does **not** free it: the caller owns the object and may
still hold the handle. Do not "fix" this.

### R7 - Do not add `anchor` to `send`, `mint`, `consume` or similar

The option exists only on `preview({ operation: "custom" })`, `executeRequest` and
`submit`. The others build their request internally, so a caller can never hold an
anchor captured for one. This is deliberate, not an oversight to be patched.

### R8 - Budget for main-thread blocking

`captureAnchor` and `preview` run in WASM on the main thread, not the worker. They
block the UI for their duration and queue other client calls behind them. Disable the
triggering control while `isCapturing` / `isPreviewing` is true.

`useTransaction().execute` is offloaded to the worker as usual.

### R9 - Import the class, not the type, to deserialize in React

`@miden-sdk/react` re-exports `ChainAnchor` and `TransactionRequest` as **types
only**, and does not re-export `InputNote` or `ForeignAccount` at
all. Calling a static such as `ChainAnchor.deserialize(bytes)` or
`TransactionRequest.deserialize(bytes)` requires importing the class from
`@miden-sdk/miden-sdk` directly.

---

## 3. Failure modes → cause

Map an observed symptom to its cause before proposing a fix.

| Symptom | Cause |
| --- | --- |
| Co-signer's summary never matches the proposer's | Anchor not passed to `preview` (R2), or the request was re-resolved instead of transported (R1, R2) |
| Co-signers' summaries differ and every other check passes | The request used `withInputNotes`, so each client chose the consumption mode from its own store. Rebuild with `withExplicitInputNote` (R3) |
| `FeeConversionInfoRequired` naming the auth component | The executing account is a multisig and the request declares no fee conversion salt. Build it from `await client.feeAwareTransactionRequestBuilder(account)` rather than a bare `TransactionRequestBuilder` |
| `FeeConversionInfoUnsupported` naming the auth component | A salt was declared against an auth component that never reads it. Drop the salt, or use `withAuthArg` plus `extendAdviceMap` |
| `ERR_FEE_CONVERSION_INFO_MISSING` aborting in the VM | A custom auth procedure reads conversion info that nothing committed. Attach it yourself with `withAuthArg` |
| `preview` fails to find the account on the co-signer | Verification runs a real execution, so the account must already be in that participant's store. `accounts.getOrImport` for a public account; a private one needs its state transferred out of band (R2) |
| Anchored execution fails naming a foreign account and a block | The anchor is older than the node's account-history window. Capture it closer to execution and re-capture an aged one (R4) |
| `INVALID_CHAIN_ANCHOR` | A sync landed mid-capture and left the anchor inconsistent. **Retry**, since this is transient rather than a bug to work around |
| `OPERATION_BUSY` | A capture or preview is already running. Await the previous one |
| `STALE_CLIENT` | The client was swapped mid-call. Recapture on the new chain |
| `TRANSACTION_ALREADY_AUTHORIZED` from `preview` | Nothing is awaiting authorization. Submit with `useTransaction` instead |
| Error thrown naming a falsy anchor | `anchor` was passed as `null`/`undefined`-adjacent, typically hook state read before the capture resolved. Await it, or omit the option |
| Generic deserialization failure on a received anchor | SDK version skew between parties. The encoding carries no version tag |
| Execution fails deep in the executor after a network switch | An anchor was carried across a client/chain swap. Anchors are chain-bound |

**Node.js note:** codes originating in the client (`INVALID_CHAIN_ANCHOR`,
`TRANSACTION_ALREADY_AUTHORIZED`) **prefix the message** instead of appearing as a
property, because the napi bindings cannot attach one. Codes originating in the React
package (`OPERATION_BUSY`, `STALE_CLIENT`) are always properties. Write error handling
that tolerates both shapes.

---

## 4. Semantics you will otherwise get wrong

- **`expirationDelta()` returning 0 means no expiration was set.** It does not mean the
  transaction has expired. Do not write a check that treats 0 as expired.
- **A matching summary proves agreement, not intent.** The commitment is built from
  exactly six things: the account delta, the input-note commitment, the output-note
  commitment, the reference block commitment, the expiration delta and the user
  params. The transaction script root, the advice map, note arguments and
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
  `summary.userParams()[0]`; the multisig component zeroes those params and binds
  nothing. Check the state you care about directly rather than inferring it from a
  matching summary.
- **`summary.outputNotes()` includes the fee note** on any chain whose verification
  base fee is non-zero. Every standard auth procedure calls `fee::pay_fee` before
  building the summary, so the fee note is inside what a co-signer signs over.
  `TransactionSummary` has no `userOutputNotes()` / `feeNote()` split, unlike
  `ExecutedTransaction`. Label it in a confirmation UI rather than presenting it as
  one of the user's own, and do not assume `outputNotes()[0]` is the note they asked
  for.
- **`preview` only yields a summary while authorization is pending.** The summary is
  produced when the account's auth procedure aborts with the unauthorized event, e.g. a
  multisig below its signing threshold. A fully authorized transaction produces no
  summary and rejects with `TRANSACTION_ALREADY_AUTHORIZED`.
- **Anchors are chain-bound, and pin chain data rather than account state.** Both React
  hooks clear their state on client change for this reason. Account records and
  authenticated input notes still come from each participant's own store, so the
  parties must agree on account state too.

---

## 5. API reference

### Core client - `client.transactions`

```ts
captureAnchor(request: TransactionRequest): Promise<ChainAnchor>

preview({ operation: "custom", account, request, anchor? })
executeRequest(account, request, { anchor? })
submit(account, request, { anchor?, ...txOptions })
```

`client.feeAwareTransactionRequestBuilder(account)` returns a
`TransactionRequestBuilder` that already declares a fee conversion salt where the
executing account needs one. It is a safe drop-in for `new
TransactionRequestBuilder()`: for an account that is not a multisig the builder
comes back untouched. A zero base fee is not a second condition: since 0.17 a
multisig resolves its auth args whatever the chain charges.

### `ChainAnchor`

| Member | Returns | Purpose |
| --- | --- | --- |
| `serialize()` | bytes | Ship alongside the request and the summary awaiting signatures |
| `ChainAnchor.deserialize(bytes)` | `ChainAnchor` | Static; rebuild on the receiving side |
| `blockNum()` | `u32` | Number of the anchored reference block |
| `commitment()` | `Word` | Commitment of the anchored reference block |
| `blockHeader()` | `BlockHeader` | The anchored reference block header, which also carries `verificationBaseFee()` and `protocolConfigCommitment()`. The fee faucet moved into the protocol configuration in 0.17; read it with `client.feeFaucetId()` |
| `free()` | void | Release the partial blockchain it carries |

### `TransactionSummary`

| Member | Returns | Purpose |
| --- | --- | --- |
| `toCommitment()` | `Word` | The value co-signers compare and sign over |
| `blockCommitment()` | `Word` | Reference block, for checking a received anchor cheaply |
| `expirationDelta()` | `u16` | 0 means no expiration was set, not expired |
| `accountDelta()` | `AccountDelta` | Inspect before signing |
| `inputNotes()` / `outputNotes()` | `InputNotes` / `OutputNotes` | Inspect before signing; `outputNotes()` includes the fee note |
| `userParams()` | `Felt[]` | Seven elements; `signature.masm` puts the final nonce in `[0]`, multisig zeroes them |
| `serialize()` / `TransactionSummary.deserialize(bytes)` | bytes / `TransactionSummary` | Transport |

### Determinism helpers for a request that travels

```ts
new TransactionRequestBuilder()
  .withExplicitInputNote(inputNote, args?)   // pins authenticated vs unauthenticated
  .withForeignAccounts([foreignAccount])     // declared foreign accounts, read at the reference block

InputNote.authenticated(note, inclusionProof)
InputNote.unauthenticated(note)

ForeignAccount.public(id, storageRequirements)
ForeignAccount.private(account)
```

### React

```ts
useChainAnchor() // { captureAnchor, anchor, anchoredRequest, isCapturing, error, reset }
usePreview()     // { preview, summary, isPreviewing, error, reset }
useTransaction() // execute({ ..., anchor? })
```

---

## 6. Reference implementation

```ts
import { ChainAnchor, TransactionRequest } from "@miden-sdk/miden-sdk";

// -- Proposer ---------------------------------------------------------
// Build from the fee-aware builder: a multisig needs a declared salt.
const builder = await client.feeAwareTransactionRequestBuilder(account);
const request = builder.withCustomScript(script).build();

const anchor  = await client.transactions.captureAnchor(request);
const summary = await client.transactions.preview({
  operation: "custom", account, request, anchor,
});
// The request travels too: a co-signer must re-derive from these exact bytes.
ship(request.serialize(), anchor.serialize(), summary.serialize());

// -- Co-signer: the proposer's request, anchor and summary -------------
const proposedRequest = TransactionRequest.deserialize(requestBytes);
const received        = ChainAnchor.deserialize(anchorBytes);
const summary = await client.transactions.preview({
  operation: "custom", account, request: proposedRequest, anchor: received,
});
if (summary.toCommitment().toHex() === expected.toCommitment().toHex()) {
  sign(summary);
}

// -- Executor ---------------------------------------------------------
await client.transactions.submit(account, proposedRequest, { anchor: received });
```

React:

```tsx
function ProposeButton({ accountId, buildRequest }: Props) {
  const { client } = useMiden();
  const { captureAnchor, isCapturing } = useChainAnchor();
  const { preview } = usePreview();

  const propose = async () => {
    // Resolve the factory here, once, and pass that one object to both calls.
    // Not `anchoredRequest`: it is state, so in this handler it still holds the
    // previous render's value, which is null on a first capture.
    const request = await buildRequest(client);
    const anchor = await captureAnchor({ request });
    const summary = await preview({ accountId, request, anchor });
    await shipToCosigners(
      request.serialize(),
      anchor.serialize(),
      summary.serialize()
    );
  };

  return <button onClick={propose} disabled={isCapturing}>Propose</button>;
}
```

`anchoredRequest` is the value to reach for one render later, when a second
interaction executes the request whose summary you just displayed.

---

## 7. Pre-ship checklist

Before considering anchor-related work complete, confirm each of these:

- [ ] The flow genuinely needs an anchor (§1). If not, `anchor` is absent everywhere.
- [ ] Every `preview` / `executeRequest` / `submit` uses the request the anchor was
      captured for, not a re-resolved one (R1).
- [ ] In React, the handler that captures passes the request it resolved itself, not
      `anchoredRequest` (R1).
- [ ] The verifying side passes the proposer's anchor **and** the proposer's request
      bytes, and already tracks the account (R2).
- [ ] Multisig requests are built from `feeAwareTransactionRequestBuilder(account)`,
      not a bare `TransactionRequestBuilder` (§3).
- [ ] Any request that travels pins its input-note modes with `withExplicitInputNote`
      (R3).
- [ ] Foreign-account inputs are fetched at `anchor.blockNum()` and no sync happens
      before execution (R4).
- [ ] Anchors from untrusted parties are checked against a trusted commitment, and the
      block is confirmed to exist (R5).
- [ ] `free()` is called in any flow that captures more than once (R6).
- [ ] Controls are disabled while `isCapturing` / `isPreviewing` (R8).
- [ ] Error handling covers both the property and message-prefix shapes of client
      codes (§3).
- [ ] `INVALID_CHAIN_ANCHOR` is retried rather than surfaced as a hard failure (§3).
- [ ] No check treats `expirationDelta() === 0` as expired (§4).
- [ ] A confirmation UI labels the fee note in `summary.outputNotes()` rather than
      presenting it as one of the user's own (§4).
