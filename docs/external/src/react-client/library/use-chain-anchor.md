---
title: useChainAnchor & usePreview
sidebar_position: 11
---

# useChainAnchor & usePreview

Capture a reference block, derive the summary pending authorization at it, and
execute against it later: the React surface for offline co-signing with a
single-signature account.

> **Multisig proposals do not need an anchor.**
> Since protocol 0.17 a multisig summary binds a bound block named in its auth
> args, not the reference block. Build the request with
> `client.feeAwareTransactionRequestBuilder(account)`, which adds that block with
> `withBlockNumbers`, and let every party `usePreview()` and `useTransaction()`
> without an anchor, at their own tip, once their client has synced to the bound
> block ([below](#multisig-proposals)). Re-executing an older multisig proposal at
> an anchor fails once the node prunes that block's account state (50 blocks), and
> a transaction executed at an older reference block expires 20 blocks after it.
> See [Multisig Proposals: Bind a Block, Execute at the Tip](../../web-client/library/transactions.md#multisig-proposals-bind-a-block-execute-at-the-tip).
> Available from `0.17.0-rc.4`.

## Multisig proposals

A multisig request from `feeAwareTransactionRequestBuilder` is previewed,
verified and executed without an anchor, each party at its own tip. The one
precondition is height: a client has to have synced to at least the bound
block, the largest of `request.blockNumbers()` (by default the proposer's sync
height when it built the request). Below it the call fails with `requested
block N is after transaction reference block M` until the client syncs.
`useTransaction` syncs before executing unless you pass `skipSync`;
`usePreview` does not, so a co-signer calls `sync()` first.

```tsx
import { useMiden, usePreview, useTransaction } from "@miden-sdk/react";
import { TransactionRequest } from "@miden-sdk/miden-sdk";

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
  const { sync } = useMiden();
  const { preview } = usePreview();

  const verify = async () => {
    await sync();
    const request = TransactionRequest.deserialize(requestBytes);
    const derived = await preview({ accountId: multisig, request });
    if (derived.toCommitment().toHex() !== proposed.toCommitment().toHex()) {
      throw new Error("proposal does not match the summary presented");
    }
    await sign(derived);
  };

  return <button onClick={verify}>Verify and sign</button>;
}

function ExecuteMultisig({ multisig, request }) {
  const { execute } = useTransaction();
  return (
    <button onClick={() => execute({ accountId: multisig, request })}>
      Execute
    </button>
  );
}
```

The rest of this page covers anchored flows, whose summary binds the reference
block.

## Why anchors exist

By default a transaction executes against the client's current sync height. A
single-signature (`signature.masm`) account's summary binds the reference block
commitment, so signatures collected over it only authorize an execution whose
reference block is the one the summary was built at.

In a flow that collects such signatures and executes later, the signer and the
executor are at different heights. Without a shared reference block, each one
derives a different summary and the signatures never match. A `ChainAnchor`
pins that reference block so everyone reproduces the same summary.

## Proposing

`useChainAnchor()` captures the anchor; `usePreview()` derives the
`TransactionSummary` the account is being asked to authorize, without
submitting anything.

```tsx
import { useChainAnchor, useMiden, usePreview } from "@miden-sdk/react";

function ProposeButton({ accountId, buildRequest }) {
  const { client } = useMiden();
  const { captureAnchor, isCapturing } = useChainAnchor();
  const { preview, isPreviewing } = usePreview();

  const propose = async () => {
    // Resolve the factory here, once, and pass that one object to both calls.
    // Don't reach for `anchoredRequest` in this handler: it is state, so it
    // still holds the previous value — `null` on a first capture. See below.
    const request = await buildRequest(client);
    const anchor = await captureAnchor({ request });
    const summary = await preview({
      accountId,
      request,
      anchor,
    });

    // Ship the request too: a co-signer must re-derive from these exact
    // bytes. On a fee-charging chain the fee conversion info carries a salt
    // drawn fresh on every build, and output notes draw fresh serial numbers,
    // so a locally rebuilt request yields a different summary.
    await shipToCosigners({
      request: request.serialize(),
      anchor: anchor.serialize(),
      summary: summary.serialize(),
    });
  };

  return (
    <button onClick={propose} disabled={isCapturing || isPreviewing}>
      Propose
    </button>
  );
}
```

## Building the request: paying the fee

These three hooks take the request from you, so paying the verification fee is
yours too. Since protocol 0.16 the fee is paid inside the account's auth
procedure, which reads the asset and rate out of the transaction's auth
argument. Fees always settle in the chain's native fee asset at rate 1/1 and
miden-client commits that itself — but it will not invent the SALT the
commitment is computed under, because a multisig reuses that salt as its
transaction summary's replay guard. A multisig request that declares none fails
with `FeeConversionInfoRequired`, so this applies squarely to the multisig flow
above.

Ask the client for a builder that already declares one:

```tsx
import { AccountId } from "@miden-sdk/miden-sdk";

const buildRequest = async (client) =>
  (await client.feeAwareTransactionRequestBuilder(AccountId.fromHex(multisigId)))
    .withCustomScript(script)
    .build();
```

The argument is the account that **executes** the request — the multisig here,
not a recipient. For an account that is not a multisig the builder comes back
untouched, so this is a safe drop-in; a zero base fee is not a second condition,
since 0.17 a multisig resolves its auth args whatever the chain charges. Requests produced by the `new*TransactionRequest` constructors
already declare a salt and need nothing extra.

Two caveats specific to this flow. `withAuthArg` and `withFeeConversionSalt`
occupy the same slot and each setter clears the other, so a request cannot carry
both. Never call either on a builder from `feeAwareTransactionRequestBuilder` for a multisig: that builder already carries the three-word auth args, and either setter discards them, so the transaction aborts in the auth procedure. Pass `feeConversionSalt` to `feeAwareTransactionRequestBuilder` instead. And because the salt and the bound block are chosen per
build, the warning below about resolving a factory exactly once applies here too
- resolve it once and pass that object to every preview and execute call. A
co-signer rebuilding the proposal instead of receiving its bytes passes
`feeConversionSalt` and `boundBlockNum`, or the two summaries cannot match.
Each call consumes the `Word`, so a second build needs a freshly constructed
one; a spent handle arrives as "no salt given" and one is drawn instead.

## Verifying and co-signing

A co-signer rebuilds the anchor from bytes and re-derives the summary **at that
anchor**. Deriving such a summary at the local sync height produces a different
one, so the comparison would fail.

```tsx
import { usePreview } from "@miden-sdk/react";
// `@miden-sdk/react` re-exports these as types only — import the runtime
// classes from the SDK package to call their static `deserialize`.
import { ChainAnchor, TransactionSummary } from "@miden-sdk/miden-sdk";

function VerifyProposal({ accountId, request, anchorBytes, summaryBytes }) {
  const { preview, isPreviewing, error } = usePreview();

  const verify = async () => {
    const anchor = ChainAnchor.deserialize(anchorBytes);
    const proposed = TransactionSummary.deserialize(summaryBytes);

    const derived = await preview({ accountId, request, anchor });
    if (derived.toCommitment().toHex() !== proposed.toCommitment().toHex()) {
      throw new Error("proposal does not match the summary presented");
    }

    await sign(derived);
  };

  return (
    <>
      {error && <div>Error: {error.message}</div>}
      <button onClick={verify} disabled={isPreviewing}>
        Verify and sign
      </button>
    </>
  );
}
```

## Executing

`useTransaction().execute` takes the same `anchor`, reproducing the execution
the signatures authorize regardless of how far the local sync height has
advanced.

```tsx
import { useTransaction } from "@miden-sdk/react";

function ExecuteButton({ accountId, request, anchor }) {
  const { execute, isLoading, stage } = useTransaction();

  return (
    <button
      onClick={() => execute({ accountId, request, anchor })}
      disabled={isLoading}
    >
      {isLoading ? `${stage}...` : "Execute"}
    </button>
  );
}
```

## API

`useChainAnchor()` returns
`{ captureAnchor, anchor, anchoredRequest, isCapturing, error, reset }`.

- `captureAnchor({ request }) → Promise<ChainAnchor>` captures at the current
  sync height. `request` accepts a `TransactionRequest` or a factory receiving
  the client, matching `useTransaction`.
- `anchor` holds the most recent capture; `reset()` clears it, `anchoredRequest`
  and any error.
- `anchoredRequest` holds the exact request that anchor was captured for.

:::warning Preview and execute against `anchoredRequest`

A factory resolves to a new `TransactionRequest` on every call, and two things
draw from the client's RNG as it does: any builder that creates an output note
draws a fresh serial number, and on a fee-charging chain the fee conversion
info's salt is drawn per build. The second applies to every request, including
custom-script ones with no output notes. Passing the factory on to `preview` or
`execute` therefore builds a *different* transaction from the one the anchor pins
— the summary your co-signers verified would not match the one submitted, and
their signatures would not apply. Every call that touches the transaction has to
receive the same object.

Which object depends on when you need it. Inside the handler that captured, use
the one you resolved yourself, as the example above does: `anchoredRequest` is
React state, so during that handler it still holds the previous render's value —
`null` the first time, and the previous request afterwards, which is the failure
this warning is about. In a later render — showing the summary, then executing on
a second click — `anchoredRequest` is the value to use, and is what it is for.

:::

`usePreview()` returns `{ preview, summary, isPreviewing, error, reset }`.

- `preview({ accountId, request, anchor? }) → Promise<TransactionSummary>`
  derives the summary without submitting. Omit `anchor` to use the current sync
  height.
- Rejects with `code: "TRANSACTION_ALREADY_AUTHORIZED"` when the transaction is
  already fully authorized and therefore produces no summary — submit it with
  `useTransaction` instead.

Both hooks reject with `code: "OPERATION_BUSY"` if called while a previous call
is still in flight. `captureAnchor` additionally rejects with
`code: "INVALID_CHAIN_ANCHOR"` when a sync lands mid-capture and leaves the
anchor internally inconsistent; retrying is the correct response.

`OPERATION_BUSY` and `STALE_CLIENT` originate in this package and are always
properties on the error. `TRANSACTION_ALREADY_AUTHORIZED` and
`INVALID_CHAIN_ANCHOR` come from the client, so on Node they prefix the message
(`"INVALID_CHAIN_ANCHOR: ..."`) rather than appearing as a property — the napi
bindings cannot attach one. In the browser all four are properties.

Both are also scoped to the client that produced them. Changing clients clears
`anchor`, `summary`, and `error`, and a call still in flight across the swap
rejects rather than returning a value bound to the chain you left — with
`code: "STALE_CLIENT"` if it would otherwise have succeeded. Nothing from the
abandoned client reaches `error` state either, so handle these rejections at
the call site. Capture again on the new client.

## Notes

- **Verify anchors from untrusted parties.** An anchor validates its own
  internal consistency on `deserialize`, so it can never be malformed — but it
  can be pinned to the wrong block, or to a block that does not exist. A
  summary signs its reference block, so checking `anchor.commitment()` against
  `summary.blockCommitment()` detects a mismatched anchor without paying for an
  execution, and re-deriving with `usePreview` confirms the request, anchor and
  summary agree. Neither check proves the block exists: `ChainAnchor` only
  validates its header against its own partial blockchain, and both sides of
  that are computable over an invented chain. Fetch the header for
  `anchor.blockNum()` with `RpcClient.getBlockHeaderByNumber` and compare
  commitments.
- **Agreement is not approval.** The request, anchor and summary all come from
  the proposer, so they agree with each other for any request the proposer
  chose — including one that drains the account. Before signing, inspect
  `summary.accountDelta()`, `summary.inputNotes()`, `summary.outputNotes()` and
  `summary.expirationDelta()` and confirm they are what you meant to approve.
  `expirationDelta()` returns `0` when no expiration was set, meaning the
  authorization never expires — not that it already has.
- **The summary does not cover the transaction script.** Its commitment is
  built from the account delta, the input and output note commitments, the
  reference block, the expiration delta and the user params — not the script
  root, advice map, note arguments or foreign-account inputs. Two requests with
  the same effects share one commitment, so the same signatures authorize both.
- **Anchored execution skips the recency check**, since it deliberately
  references a block older than the tip. `useTransaction` syncs before
  executing unless you pass `skipSync`, so this is only observable with
  `{ skipSync: true, anchor }` — that combination will execute against an old
  block where an unanchored execute would refuse.
- **An anchor pins chain data, not account state.** Account records and
  authenticated input notes still come from each participant's own local store,
  so all parties must agree on the account state too. If the account moved in a
  way that changes the transaction's effects, the re-derived summary will not
  match even though the anchor is correct - the most common reason a co-signing
  flow fails.

  A match does not prove the reverse. The summary binds the account *delta*,
  not the state it applies to, so divergence that leaves the delta and note
  sets unchanged — an unrelated nonce bump, assets arriving, or a change to a
  multisig's signer set or threshold — produces an identical commitment and
  passes verification. Signatures gathered under one threshold remain valid
  after it is lowered. Check the state you care about directly.
- **`usePreview` and `useChainAnchor` run on the main thread.** Both execute a
  full transaction in the VM, and neither is offloaded to the worker (matching
  the existing unanchored `executeForSummary`), so a preview blocks the UI and
  queues other client calls behind it. Only `useTransaction().execute` is
  worker-backed.
- **An anchor is captured for a specific request, but is not an identity for
  one.** It tracks the blocks that request declares through `withBlockNumbers`
  and the creation blocks of its authenticated input notes, so a different
  request fails against it only when it needs a block the anchor doesn't
  track.
  What binds a request to a summary is the summary commitment, not the anchor.
- **The anchor handle is reusable** — it is borrowed rather than consumed, so
  one anchor can drive the preview and the execution.
