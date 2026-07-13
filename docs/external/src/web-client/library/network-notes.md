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

A network account is an ordinary **public** account carrying the network-account
auth component. That component stores a note-script allowlist in a standardized
storage slot; the node reads it to recognize the account as a network account
and to decide which notes it may auto-consume. Build the component with
`AccountComponent.createNetworkAuth(allowedNoteScriptRoots)`
and attach it to your account alongside its business logic:

```typescript
import {
  AccountBuilder,
  AccountComponent,
  AccountStorageMode,
  TransactionRequestBuilder,
} from "@miden-sdk/miden-sdk";

// The account may only consume notes whose script root is allowlisted, so
// compile the note script the account expects and take its root. Reuse the
// same compiled script when you build the network note (the roots must match).
const auth = AccountComponent.createNetworkAuth([
  noteScript.root(),
]);

const { account } = new AccountBuilder(seed)
  .storageMode(AccountStorageMode.public())
  .withComponent(myComponent)
  .withAuthComponent(auth)
  .build();

await client.accounts.insert({ account });

// The auth component forbids transaction scripts and bumps the nonce itself, so
// an empty (scriptless) transaction is enough to commit the account on-chain.
await client.transactions.submit(
  account.id(),
  new TransactionRequestBuilder().build()
);
```

The allowlist must be non-empty — a network account with no allowlisted note
scripts could never consume a note, so `createNetworkAuth([])`
throws. By default transaction scripts are disallowed, so a network account only
advances by consuming allowlisted network notes (the node runs the transaction)
or via scriptless transactions.

An optional second argument allowlists transaction script roots (from
`TransactionScript.root()`) the account will execute:

```typescript
const auth = AccountComponent.createNetworkAuth(
  [myNoteScript.root()],
  [myMaintenanceTxScript.root()]
);
```

Only allowlist a transaction script whose effect is safe for **every** possible
input — a root pins the script's code but not its arguments or advice inputs,
which the (arbitrary) transaction submitter controls.

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
