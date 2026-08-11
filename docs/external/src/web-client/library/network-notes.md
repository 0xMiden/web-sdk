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

## Creating a network account

A network account is a **public** account carrying the network-account auth
component, whose note-script allowlist tells the node which notes the account
may auto-consume:

```typescript
import {
  AccountBuilder,
  AccountComponent,
  AccountStorageMode,
  NoteFee,
  TransactionRequestBuilder,
} from "@miden-sdk/miden-sdk";

// Reuse the same compiled note script when building the network note, so
// the allowlisted root matches.
//
// Each allowlisted script also needs a price, denominated in the fungible
// asset of `feeFaucetId`. A zero price is valid; an omitted one is not.
const components = AccountComponent.createNetworkAuth(
  [noteScript.root()],
  feeFaucetId,
  [new NoteFee(noteScript.root(), 0n)]
);

const builder = new AccountBuilder(seed)
  .storageMode(AccountStorageMode.public())
  .withComponent(myComponent);
// `createNetworkAuth` returns the auth component together with the
// components backing its fee policy; install all of them.
for (const component of components) builder.withComponent(component);
const { account } = builder.build();

await client.accounts.insert({ account });

// The auth component bumps the nonce itself, so a scriptless transaction
// commits the account on-chain.
await client.transactions.submit(
  account.id(),
  new TransactionRequestBuilder().build()
);
```

The allowlist must be non-empty (`createNetworkAuth([], ...)` throws), and every
root in it must be priced by the fee schedule — a root the schedule omits aborts
the account's fee estimation rather than defaulting to free, so the call rejects
it up front. The canonical expiration transaction script is always allowlisted,
since the node attaches it to every network transaction; any other transaction
script is forbidden unless its root (`TransactionScript.root()`) is allowlisted
via the optional fourth argument — only allowlist scripts whose effect is safe
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
