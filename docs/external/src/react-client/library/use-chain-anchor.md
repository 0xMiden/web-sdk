---
title: useChainAnchor & usePreview
sidebar_position: 11
---

# useChainAnchor & usePreview

Capture a reference block, derive the summary pending authorization at it, and
execute against it later — the React surface for multisig proposals and offline
co-signing.

## Why anchors exist

By default a transaction executes against the client's current sync height.
Since protocol 0.16 a signed transaction summary binds the reference block
commitment, so signatures collected over a summary only authorize an execution
whose reference block is the one the summary was built at.

In a flow that collects signatures and executes later, the proposer, each
co-signer, and the executor are all at different heights. Without a shared
reference block, each one derives a different summary and the signatures never
match. A `ChainAnchor` pins that reference block so everyone reproduces the
same summary.

## Proposing

`useChainAnchor()` captures the anchor; `usePreview()` derives the
`TransactionSummary` the account is being asked to authorize, without
submitting anything.

```tsx
import { useChainAnchor, usePreview } from "@miden-sdk/react";

function ProposeButton({ multisigId, buildRequest }) {
  const { captureAnchor, anchoredRequest, isCapturing } = useChainAnchor();
  const { preview, isPreviewing } = usePreview();

  const propose = async () => {
    const anchor = await captureAnchor({ request: buildRequest });
    // `anchoredRequest`, not `buildRequest`: see the note below.
    const summary = await preview({
      accountId: multisigId,
      request: anchoredRequest,
      anchor,
    });

    await shipToCosigners({
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

## Verifying and co-signing

A co-signer rebuilds the anchor from bytes and re-derives the summary **at that
anchor**. Deriving it at the local sync height produces a different summary, so
the comparison would always fail.

```tsx
import { usePreview } from "@miden-sdk/react";
// `@miden-sdk/react` re-exports these as types only — import the runtime
// classes from the SDK package to call their static `deserialize`.
import { ChainAnchor, TransactionSummary } from "@miden-sdk/miden-sdk";

function VerifyProposal({ multisigId, request, anchorBytes, summaryBytes }) {
  const { preview, isPreviewing, error } = usePreview();

  const verify = async () => {
    const anchor = ChainAnchor.deserialize(anchorBytes);
    const proposed = TransactionSummary.deserialize(summaryBytes);

    const derived = await preview({ accountId: multisigId, request, anchor });
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

function ExecuteButton({ multisigId, request, anchor }) {
  const { execute, isLoading, stage } = useTransaction();

  return (
    <button
      onClick={() => execute({ accountId: multisigId, request, anchor })}
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

A factory resolves to a new `TransactionRequest` on every call, and any builder
that creates an output note draws a fresh serial number from the client's RNG.
Passing the factory on to `preview` or `execute` therefore builds a *different*
transaction from the one the anchor pins — the summary your co-signers verified
would not match the one submitted, and their signatures would not apply. Reuse
`anchoredRequest`, or capture from a concrete `TransactionRequest` you hold.

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
  summary agree.
- **Agreement is not approval.** The request, anchor and summary all come from
  the proposer, so they agree with each other for any request the proposer
  chose — including one that drains the account. Before signing, inspect
  `summary.accountDelta()`, `summary.inputNotes()`, `summary.outputNotes()` and
  `summary.expirationDelta()` and confirm they are what you meant to approve.
- **Anchored execution skips the recency check**, since it deliberately
  references a block older than the tip. `useTransaction` syncs before
  executing unless you pass `skipSync`, so this is only observable with
  `{ skipSync: true, anchor }` — that combination will execute against an old
  block where an unanchored execute would refuse.
- **An anchor pins chain data, not account state.** Account records and
  authenticated input notes still come from each participant's own local store,
  so all parties must agree on the account state too. If the account moved
  between the proposal and the verification, the re-derived summary will not
  match even though the anchor is correct — the most common reason a multisig
  flow fails. It fails closed: the co-signer refuses to sign.
- **An anchor is captured for a specific request.** It tracks that request's
  authenticated input notes, so executing a different request against it fails
  if the new request consumes a note the anchor doesn't track.
- **The anchor handle is reusable** — it is borrowed rather than consumed, so
  one anchor can drive the preview and the execution.
