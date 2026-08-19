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

function ProposeButton({ multisigId, request }) {
  const { captureAnchor, isCapturing } = useChainAnchor();
  const { preview, isPreviewing } = usePreview();

  const propose = async () => {
    const anchor = await captureAnchor({ request });
    const summary = await preview({ accountId: multisigId, request, anchor });

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

`useChainAnchor()` returns `{ captureAnchor, anchor, isCapturing, error, reset }`.

- `captureAnchor({ request }) → Promise<ChainAnchor>` captures at the current
  sync height. `request` accepts a `TransactionRequest` or a factory receiving
  the client, matching `useTransaction`.
- `anchor` holds the most recent capture; `reset()` clears it and any error.

`usePreview()` returns `{ preview, summary, isPreviewing, error, reset }`.

- `preview({ accountId, request, anchor? }) → Promise<TransactionSummary>`
  derives the summary without submitting. Omit `anchor` to use the current sync
  height.
- Rejects with `code: "TRANSACTION_ALREADY_AUTHORIZED"` when the transaction is
  already fully authorized and therefore produces no summary — submit it with
  `useTransaction` instead.

Both hooks reject with `code: "OPERATION_BUSY"` if called while a previous call
is still in flight.

Both are also scoped to the client that produced them. Changing clients clears
`anchor`, `summary`, and `error`, and a call still in flight across the swap
rejects rather than returning a value bound to the chain you left — with
`code: "STALE_CLIENT"` if it would otherwise have succeeded. Nothing from the
abandoned client reaches `error` state either, so handle these rejections at
the call site. Capture again on the new client.

## Notes

- **Verify anchors from untrusted parties.** An anchor validates its own
  internal consistency on `deserialize`, so it can never be malformed — but it
  can be pinned to the wrong block. Compare `anchor.commitment()` against the
  commitment bound into the summary before executing with it.
- **An anchor is captured for a specific request.** It tracks that request's
  authenticated input notes, so executing a different request against it fails
  if the new request consumes a note the anchor doesn't track.
- **The anchor handle is reusable** — it is borrowed rather than consumed, so
  one anchor can drive the preview and the execution.
