---
title: Network Notes
sidebar_position: 20
---

# Network Notes

A network note is a Public note carrying a `NetworkAccountTarget` attachment.
Once it lands on-chain, the targeted network account auto-consumes it — there's
no manual `consume` call on the recipient side. Build and submit one with a
custom consumption script:

```typescript
import { MidenClient } from "@miden-sdk/miden-sdk";

const client = await MidenClient.create();

const req = await client.transactions.createNetworkNote({
  account: senderId,
  target: networkAccountId,
  script: myNoteScript, // or: recipient: myRecipient
  waitForConfirmation: true,
});

console.log(req.note.isNetworkNote()); // true
```

`createNetworkNote` builds the note (`Note.withAttachments` plus a
`NetworkAccountTarget` attachment), submits it as an own output note, and
returns `{ txId, note, result }`. Provide exactly one of `script` or
`recipient` — passing both, or neither, throws. Notes are always Public — the
attachment, not the tag, is what a network account matches on.

## Targeting a network account

`target` accepts an account reference (hex/bech32 id or `AccountId`), or a
pre-built `NetworkAccountTarget` when you need control over the execution
hint:

```typescript
import { NetworkAccountTarget, NoteExecutionHint } from "@miden-sdk/miden-sdk";

const target = new NetworkAccountTarget(
  networkAccountId,
  NoteExecutionHint.always()
);

await client.transactions.createNetworkNote({
  account: senderId,
  target,
  recipient: myRecipient,
});
```

On the plain-reference form, `executionHint` defaults to `always`.

## Assets and extra attachments

`assets` locks one or more assets into the note; omit it for a zero-asset
note. `attachment` appends an extra payload after the required
`NetworkAccountTarget` — read every attachment back with `note.attachments()`:

```typescript
const { note } = await client.transactions.createNetworkNote({
  account: senderId,
  target: networkAccountId,
  script: myNoteScript,
  assets: [{ token: dagToken, amount: 100n }],
  attachment: [1n, 2n, 3n],
});

note.attachments(); // [NetworkAccountTarget attachment, extra payload]
```

## Who pays on a fee-charging chain

**The sender funds the consumption, at note-creation time.** This is the part
that surprises people: creating a network note is not free of the consuming
transaction's cost.

When the sender's transaction pays its own fee, `fee::pay_fee` first creates a
`FEE_SPONSORSHIP` note for every network output note the transaction emits. Each
one is priced by asking the *target* network account for its fee policy — the
`NoteScriptFee` it allowlisted for that note's script, denominated in the
target's `feeFaucetId` — and funded out of the sender's vault. The network
account collects that sponsorship note when it consumes the note, and uses it to
pay. Only a script the target priced at zero produces no sponsorship note.

Two consequences worth planning for:

- **The pricing is an FPI call into the target**, so the target account must be
  provisioned as a foreign account on the sender's transaction. It is made for
  every network output note before the price is known, so a zero-priced script
  does not avoid it — anywhere the sender's auth procedure pays a fee at all,
  the provisioning is required. `createNetworkNote` does not add it, so on a
  fee-charging chain assemble the request yourself: take a builder from
  `client.feeAwareTransactionRequestBuilder(sender)` (which also declares a fee
  conversion salt where the sender needs one), add the target with
  `withForeignAccounts`, and submit it through `client.transactions.execute`.
- **The sender's vault must cover the sponsorship**, not just its own fee. An
  underfunded sender aborts rather than emitting an unsponsored note, and a
  target whose fee policy is unset or unreachable aborts the same way.

`NoteScript.feeSponsorship()` is the script those notes carry, and
`AccountComponent.createNetworkAuthComponents` allowlists it at zero by default,
so charging for it is a deliberate act —
`new NoteScriptFee(NoteScript.feeSponsorship().root(), amount)`.

## Creating a network account

A network account is a **public** account carrying the network-account auth
component, whose note-script allowlist tells the node which notes the account
may auto-consume:

```typescript
import {
  AccountBuilder,
  AccountComponent,
  AccountStorageMode,
  NoteScriptFee,
  TransactionRequestBuilder,
} from "@miden-sdk/miden-sdk";

// Reuse the same compiled note script when building the network note, so
// the allowlisted root matches.
//
// Each allowed script carries the fee charged to consume it, denominated in
// the fungible asset of `feeFaucetId`. A zero price is valid.
const components = AccountComponent.createNetworkAuthComponents(
  [new NoteScriptFee(noteScript.root(), 0n)],
  feeFaucetId
);

const builder = new AccountBuilder(seed)
  .storageMode(AccountStorageMode.public())
  .withComponent(myComponent);
// `createNetworkAuthComponents` returns the auth component together with the
// components backing its fee policy; install all of them.
for (const component of components) builder.withComponent(component);
const { account } = builder.build();

await client.accounts.insert({ account });

// The auth component bumps the nonce itself, so a scriptless transaction
// commits the account on-chain. The bare builder is right here even on a
// fee-charging chain: the network-account auth component pays the fee from the
// chain's native conversion info rather than the transaction's auth args, so
// there is nothing to attach. See "Which accounts read conversion info" in the
// transactions guide.
await client.transactions.submit(
  account.id(),
  new TransactionRequestBuilder().build()
);
```

The allowlist must be non-empty (`createNetworkAuthComponents([], ...)` throws).
Each entry prices its own script, so an allowlisted script can never be left
unpriced, which would abort the account's fee estimation rather than defaulting
to free. The canonical expiration transaction script is always allowlisted,
since the node attaches it to every network transaction; any other transaction
script is forbidden unless its root (`TransactionScript.root()`) is allowlisted
via the optional third argument — only allowlist scripts whose effect is safe
for every possible input, since a root pins the code but not the
submitter-controlled arguments.

## Detecting a network account

`account.isNetworkAccount()` reports whether an account carries the allowlist
slot; `account.networkNoteAllowlist()` returns the allowed note-script roots
(`Word[]`), or `undefined` for non-network accounts.

## Building without submitting

The standalone `buildNetworkNote(opts)` builds the same `Note` without
submitting — useful when you need to inspect, batch, or otherwise hold onto
the note before sending it via `client.transactions.submit(...)` or
`client.transactions.batch(...)`:

```typescript
import { buildNetworkNote } from "@miden-sdk/miden-sdk";

const note = buildNetworkNote({
  account: senderId,
  target: networkAccountId,
  script: myNoteScript,
});
```

## See also

- [Transactions](./transactions.md) — general transaction submission and batching.
