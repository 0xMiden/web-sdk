---
title: usePreview
sidebar_position: 11
---

# usePreview

Derive the transaction summary that an account is asked to authorize, without
submitting anything: the React surface for multisig proposals and co-signing.

`usePreview()` runs the request at the client's sync height and returns the
`TransactionSummary`. A transaction always executes at the sync height too, so
nothing pins a reference block. Which flows that allows depends on what the
summary binds:

- A **multisig** summary binds a bound block named in its auth args. Every
  party previews and executes at its own tip. See
  [Multisig proposals](#multisig-proposals).
- A **single-signature** (`signature.masm`) summary binds the reference block.
  It reproduces only at the same sync height. See
  [Summaries that bind the reference block](#summaries-that-bind-the-reference-block).

## Multisig proposals

A multisig request from `feeAwareTransactionRequestBuilder` is previewed,
verified and executed by each party at its own tip. The one precondition is
height: a client has to have synced to at least the bound block, the largest of
`request.blockNumbers()` (by default the proposer's sync height when it built
the request). Below it the call fails with `requested block N is after
transaction reference block M` until the client syncs.
`useTransaction` syncs before executing unless you pass `skipSync`, and
`usePreview` does not sync at all. Both go through the provider's `sync()`,
which returns early while another sync is running and records a failure rather
than throwing, so check the height after syncing rather than assuming it.

A request from `withFeeAwareAuth` does not declare the bound block, so the
check below cannot read it from `request.blockNumbers()` and does not wait for
it. Sync before previewing such a request, and treat `requested block N is
after transaction reference block M` as a reason to sync again.

```tsx
import { useMiden, usePreview, useTransaction } from "@miden-sdk/react";
import { TransactionRequest } from "@miden-sdk/miden-sdk";

// The provider's sync() can return without reaching the tip, so confirm the
// client has synced to the proposal's bound block before using it.
async function assertSyncedTo(client, sync, request) {
  await sync();
  const bound = Math.max(0, ...request.blockNumbers());
  if ((await client.getSyncHeight()) < bound) {
    throw new Error("not synced to the proposal's bound block yet; retry");
  }
}

function ProposeMultisig({ multisig, script }) {
  const { client } = useMiden();
  const { preview } = usePreview();

  const propose = async () => {
    // Build once and ship these bytes: a rebuild draws a new salt and would
    // bind a different summary.
    const request = (await client.feeAwareTransactionRequestBuilder(multisig))
      .withCustomScript(script)
      .build();
    const summary = await preview({ accountId: multisig, request });
    await shipToCosigners({
      request: request.serialize(),
      summary: summary.serialize(),
    });
  };

  return <button onClick={propose}>Propose</button>;
}

function VerifyMultisig({ multisig, requestBytes, proposed }) {
  const { client, sync } = useMiden();
  const { preview } = usePreview();

  const verify = async () => {
    const request = TransactionRequest.deserialize(requestBytes);
    await assertSyncedTo(client, sync, request);
    const derived = await preview({ accountId: multisig, request });
    if (derived.toCommitment().toHex() !== proposed.toCommitment().toHex()) {
      throw new Error("proposal does not match the summary presented");
    }
    await sign(derived);
  };

  return <button onClick={verify}>Verify and sign</button>;
}

function ExecuteMultisig({ multisig, request }) {
  const { client, sync } = useMiden();
  const { execute } = useTransaction();

  const run = async () => {
    await assertSyncedTo(client, sync, request);
    await execute({ accountId: multisig, request, skipSync: true });
  };

  return <button onClick={run}>Execute</button>;
}
```

`@miden-sdk/react` re-exports `TransactionRequest` and `TransactionSummary` as
types only. Import the classes from `@miden-sdk/miden-sdk` to call their static
`deserialize`.

### Building the request: paying the fee

These hooks take the request from you, so paying the verification fee is yours
too. Since protocol 0.16 the fee is paid inside the account's auth procedure,
which reads the asset and rate out of the transaction's auth argument. Fees
always settle in the chain's native fee asset at rate 1/1 and miden-client
commits that itself - but it will not invent the SALT the commitment is computed
under, because a multisig reuses that salt as its transaction summary's replay
guard. A multisig request that declares none fails with
`FeeConversionInfoRequired`, which is why the proposer above builds with
`feeAwareTransactionRequestBuilder`:

```tsx
const request = (await client.feeAwareTransactionRequestBuilder(multisig))
  .withCustomScript(script)
  .build();
```

The argument is the account that **executes** the request - the multisig, not a
recipient. For an account that is not a multisig the builder comes back
untouched, so this is a safe drop-in; a zero base fee is not a second condition,
since 0.17 a multisig resolves its auth args whatever the chain charges.
Requests produced by the `new*TransactionRequest` constructors already declare a
salt and need nothing extra. A wallet handed a finished request, such as a
dApp's, cannot rebuild it, so it adds the same auth args with
`await client.withFeeAwareAuth(request, multisig)`.

Two caveats. `withAuthArgs` and `withFeeConversionSalt` occupy the same slot and
each setter clears the other, so a request cannot carry both. Never call either
on a builder from `feeAwareTransactionRequestBuilder` for a multisig: that
builder already carries the three-word auth args, and either setter discards
them, so the transaction aborts in the auth procedure. Pass `feeConversionSalt`
to `feeAwareTransactionRequestBuilder` instead. And because the salt and the
bound block are chosen per build, build the request once and ship its bytes, as
the proposer above does. Co-signers re-derive from those bytes; one that
rebuilds the proposal instead must pass the same `feeConversionSalt` and
`boundBlockNum`, or the two summaries cannot match. Each call consumes the
`Word`, so a second build needs a freshly constructed one; a spent handle
arrives as "no salt given" and one is drawn instead.

## Summaries that bind the reference block

A single-signature (`signature.masm`) account's summary binds the reference
block commitment, so a signature over it authorizes only an execution whose
reference block is the one the summary was built at. The reference block is the
client's sync height, so such a summary reproduces only at the sync height it
was derived at:

- A sync between the preview and the execution moves the reference block, and
  the signature no longer authorizes the execution.
- `useTransaction().execute` syncs before it executes unless `skipSync` is set.
- `MidenProvider` syncs on its `autoSyncInterval`.
- A client at another sync height derives a different summary from the same
  request.

For signatures that are collected over time or on other clients, use a multisig
account. `useChainAnchor` and the `anchor` option of `usePreview` and
`useTransaction` pinned the reference block in earlier versions. They were
removed in `0.19.0`.

## API

`usePreview()` returns `{ preview, summary, isPreviewing, error, reset }`.

- `preview({ accountId, request }) → Promise<TransactionSummary>` derives the
  summary at the current sync height without submitting. `request` accepts a
  `TransactionRequest` or a factory receiving the client, matching
  `useTransaction`.
- `summary` holds the most recent result; `reset()` clears it and any error.
- Rejects with `code: "TRANSACTION_ALREADY_AUTHORIZED"` when the transaction is
  already fully authorized and therefore produces no summary — submit it with
  `useTransaction` instead.
- Rejects with `code: "OPERATION_BUSY"` if called while a previous call is
  still in flight.

:::warning Pass one resolved request to every call

A factory resolves to a new `TransactionRequest` on every call, and two things
draw from the client's RNG as it does: any builder that creates an output note
draws a fresh serial number, and a multisig request draws a fresh salt per
build. Passing the factory to `preview` and again to `execute` therefore builds
a *different* transaction — the summary your co-signers verified would not
match the one submitted, and their signatures would not apply. Resolve the
request once and pass that object to every call.

:::

`OPERATION_BUSY` and `STALE_CLIENT` originate in this package and are always
properties on the error. `TRANSACTION_ALREADY_AUTHORIZED` comes from the client,
so on Node it prefixes the message (`"TRANSACTION_ALREADY_AUTHORIZED: ..."`)
rather than appearing as a property — the napi bindings cannot attach one. In
the browser all three are properties.

The hook is scoped to the client that produced the summary. Changing clients
clears `summary` and `error`, and a call still in flight across the swap rejects
rather than returning a value bound to the chain you left — with
`code: "STALE_CLIENT"` if it would otherwise have succeeded. Nothing from the
abandoned client reaches `error` state either, so handle these rejections at
the call site. Preview again on the new client.

## Notes

- **Agreement is not approval.** The request and the summary both come from
  the proposer, so they agree with each other for any request the proposer
  chose — including one that drains the account. Before signing, inspect
  `summary.accountDelta()`, `summary.inputNotes()`, `summary.outputNotes()` and
  `summary.expirationDelta()` and confirm they are what you meant to approve.
  `expirationDelta()` returns `0` when no expiration was set, meaning the
  authorization never expires — not that it already has.
- **The summary does not cover the transaction script.** Its commitment is
  built from the account delta, the input and output note commitments, the
  reference block (the bound block, for a multisig), the expiration delta and
  the user params — not the script root, advice map, note arguments or
  foreign-account inputs. Two requests with the same effects share one
  commitment, so the same signatures authorize both.
- **Confirm the bound block of a proposal is real.** For a multisig,
  `summary.blockCommitment()` is the commitment of the bound block and
  `summary.blockNum()` is its number. Fetch that header with
  `RpcClient.getBlockHeaderByNumber` from a node you trust and compare
  commitments.
- **Account state comes from each participant's own store.** So do
  authenticated input notes, and all parties must agree on the account state
  too. If the account moved in a way that changes the transaction's effects,
  the re-derived summary will not match - the most common reason a co-signing
  flow fails.

  A match does not prove the reverse. The summary binds the account *delta*,
  not the state it applies to, so divergence that leaves the delta and note
  sets unchanged — an unrelated nonce bump, assets arriving, or a change to a
  multisig's signer set or threshold — produces an identical commitment and
  passes verification. Signatures gathered under one threshold remain valid
  after it is lowered. Check the state you care about directly.
- **`usePreview` runs on the main thread.** It executes a full transaction in
  the VM and is not offloaded to the worker, so a preview blocks the UI and
  queues other client calls behind it. Only `useTransaction().execute` is
  worker-backed.
