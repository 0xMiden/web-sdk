---
name: chain-anchored-execution
description: Rules for using ChainAnchor to pin transaction execution to a specific block, required whenever a signature is collected over a transaction summary by one party and the transaction is executed later or by another party — multisig proposals and offline co-signing. Use when writing or reviewing code that calls captureAnchor, preview, executeRequest or submit with an anchor, uses useChainAnchor or usePreview, or when debugging summary commitments that never match between co-signers, INVALID_CHAIN_ANCHOR, OPERATION_BUSY, STALE_CLIENT or TRANSACTION_ALREADY_AUTHORIZED.
---

# Chain-Anchored Execution

**Availability:** `@miden-sdk/miden-sdk` and `@miden-sdk/react` from `0.16.0-rc.3`.
This skill ships inside the package, so if you are reading it from
`node_modules/@miden-sdk/miden-sdk/skills/`, the installed version has these
surfaces. If the symbols are missing anyway, the build is pinned to
`miden-client` 0.16.0-rc.1 or earlier, which does not contain chain-anchored
execution — check the client pin before anything else.

Source of truth: [web-sdk#301](https://github.com/0xMiden/web-sdk/pull/301) and
[#302](https://github.com/0xMiden/web-sdk/pull/302).

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

### R1 — Execute the exact request object the anchor was captured for

Never re-resolve a request factory or re-run a builder after capturing. Calling it
again returns a different object, and any builder that creates an output note draws a
fresh serial number from the client's RNG. The result is a materially different
transaction that the anchor does not pin and the co-signers did not approve.

In React, `useChainAnchor()` returns `anchoredRequest` for precisely this reason.

```tsx
// CORRECT
const anchor = await captureAnchor({ request: buildRequest });
await preview({ accountId, request: anchoredRequest!, anchor });

// WRONG — buildRequest resolves to a different transaction
const anchor = await captureAnchor({ request: buildRequest });
await preview({ accountId, request: buildRequest, anchor });
```

### R2 — A verifying co-signer must pass the proposer's anchor to `preview`

Omitting it derives the summary at the local sync height, producing a different
commitment every time. The comparison then fails permanently and looks like a
verification bug.

### R3 — Validate an anchor that arrives from an untrusted party

Malformed anchors are impossible — the chain-length and peak-hash invariants are
enforced natively on construction and on `deserialize`, and trailing bytes are
rejected. What remains possible is an anchor pinned to the **wrong** block, or to a
block that never existed.

1. Compare `anchor.commitment()` against `summary.blockCommitment()`.
2. Stronger: re-derive the summary at the anchor and compare `toCommitment()`, which
   also binds the request and the local account state.
3. Neither detects a **fabricated** block — both invariants hold over an entirely
   invented chain. Fetch the header for `anchor.blockNum()` from a node if you need
   that guarantee.

Do not escalate a fabricated-block risk beyond its actual severity: such a transaction
cannot be submitted and its signature cannot be moved onto a real one, so the cost is a
wasted proof rather than funds. The header does, however, supply the block number,
timestamp and fee parameters execution runs against.

### R4 — Free anchors in repeated-capture flows

An anchor carries a partial blockchain. Call `anchor.free()` when done rather than
waiting for the finalizer.

React's `reset()` deliberately does **not** free it: the caller owns the object and may
still hold the handle. Do not "fix" this.

### R5 — Do not add `anchor` to `send`, `mint`, `consume` or similar

The option exists only on `preview({ operation: "custom" })`, `executeRequest` and
`submit`. The others build their request internally, so a caller can never hold an
anchor captured for one. This is deliberate, not an oversight to be patched.

### R6 — Budget for main-thread blocking

`captureAnchor` and `preview` run in WASM on the main thread, not the worker. They
block the UI for their duration and queue other client calls behind them. Disable the
triggering control while `isCapturing` / `isPreviewing` is true.

`useTransaction().execute` is offloaded to the worker as usual.

### R7 — Import the class, not the type, to deserialize in React

`@miden-sdk/react` re-exports `ChainAnchor` as a **type only**. Calling the static
`ChainAnchor.deserialize(bytes)` requires importing the class from
`@miden-sdk/miden-sdk` directly.

---

## 3. Failure modes → cause

Map an observed symptom to its cause before proposing a fix.

| Symptom | Cause |
| --- | --- |
| Co-signer's summary never matches the proposer's | Anchor not passed to `preview` (R2), or the request was re-resolved (R1) |
| `INVALID_CHAIN_ANCHOR` | A sync landed mid-capture and left the anchor inconsistent. **Retry** — this is transient, not a bug to work around |
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
- **A matching summary proves agreement, not intent.** The commitment covers the
  account delta, the note commitments, the reference block, the expiration delta and
  the user params. It does **not** cover the transaction script or the advice inputs.
  Do not describe a summary match as proof that the transaction does what a user
  intended.
- **`preview` only yields a summary while authorization is pending.** The summary is
  produced when the account's auth procedure aborts with the unauthorized event, e.g. a
  multisig below its signing threshold. A fully authorized transaction produces no
  summary and rejects with `TRANSACTION_ALREADY_AUTHORIZED`.
- **Anchors are chain-bound.** Both React hooks clear their state on client change for
  this reason.

---

## 5. API reference

### Core client — `client.transactions`

```ts
captureAnchor(request: TransactionRequest): Promise<ChainAnchor>

preview({ operation: "custom", account, request, anchor? })
executeRequest(account, request, { anchor? })
submit(account, request, { anchor?, ...txOptions })
```

### `ChainAnchor`

| Member | Returns | Purpose |
| --- | --- | --- |
| `serialize()` | bytes | Ship alongside a summary awaiting signatures |
| `ChainAnchor.deserialize(bytes)` | `ChainAnchor` | Static; rebuild on the receiving side |
| `blockNum()` | `u32` | Number of the anchored reference block |
| `commitment()` | `Word` | Commitment of the anchored reference block |
| `blockHeader()` | `BlockHeader` | The anchored reference block header |
| `free()` | — | Release the partial blockchain it carries |

### `TransactionSummary`

Gained `blockCommitment()` and `expirationDelta()`, alongside the existing
`toCommitment()`, `serialize()` and `deserialize()`.

### React

```ts
useChainAnchor() // { captureAnchor, anchor, anchoredRequest, isCapturing, error, reset }
usePreview()     // { preview, summary, isPreviewing, error, reset }
useTransaction() // execute({ ..., anchor? })
```

---

## 6. Reference implementation

```ts
// ── Proposer ──────────────────────────────────────────────────────────
const anchor  = await client.transactions.captureAnchor(request);
const summary = await client.transactions.preview({
  operation: "custom", account, request, anchor,
});
ship(anchor.serialize(), summary.serialize());

// ── Co-signer — proposer's anchor, and the same request ───────────────
const anchor  = ChainAnchor.deserialize(bytes);
const summary = await client.transactions.preview({
  operation: "custom", account, request, anchor,
});
if (summary.toCommitment().toHex() === expected.toCommitment().toHex()) {
  sign(summary);
}

// ── Executor ──────────────────────────────────────────────────────────
await client.transactions.submit(account, request, { anchor });
```

React:

```tsx
function ProposeButton({ accountId, buildRequest }: Props) {
  const { captureAnchor, anchoredRequest, isCapturing } = useChainAnchor();
  const { preview } = usePreview();

  const propose = async () => {
    const anchor = await captureAnchor({ request: buildRequest });
    // anchoredRequest, not buildRequest: the anchor pins this exact object.
    const summary = await preview({
      accountId,
      request: anchoredRequest!,
      anchor,
    });
    await shipToCosigners(anchor.serialize(), summary.serialize());
  };

  return <button onClick={propose} disabled={isCapturing}>Propose</button>;
}
```

---

## 7. Pre-ship checklist

Before considering anchor-related work complete, confirm each of these:

- [ ] The flow genuinely needs an anchor (§1). If not, `anchor` is absent everywhere.
- [ ] Every `preview` / `executeRequest` / `submit` uses the request the anchor was
      captured for, not a re-resolved one (R1).
- [ ] The verifying side passes the proposer's anchor (R2).
- [ ] Anchors from untrusted parties are checked against a trusted commitment (R3).
- [ ] `free()` is called in any flow that captures more than once (R4).
- [ ] Controls are disabled while `isCapturing` / `isPreviewing` (R6).
- [ ] Error handling covers both the property and message-prefix shapes of client
      codes (§3).
- [ ] `INVALID_CHAIN_ANCHOR` is retried rather than surfaced as a hard failure (§3).
- [ ] No check treats `expirationDelta() === 0` as expired (§4).
