---
title: Foreign Accounts
sidebar_position: 30
---

# Foreign Accounts

A transaction that invokes a procedure on an account other than the one executing it (foreign
procedure invocation) declares that account as a `ForeignAccount` on the request. The declaration
tells the client what to load, and when.

There are three kinds.

## Public

The account's state and code are fetched from the network at execution time. Declaring the storage
requirements upfront means the storage map entries the procedure reads are fetched in the same RPC
call:

```typescript
import { ForeignAccount, AccountStorageRequirements } from "@miden-sdk/miden-sdk";

const foreign = ForeignAccount.public(
  oracleAccountId,
  new AccountStorageRequirements()
);
```

An undeclared public account is loaded lazily with empty storage requirements, and each storage map
access then costs an extra RPC call during execution.

## Private

A private account's state is not on the network, so the caller supplies it. Only a proof of the
account's inclusion is fetched at execution time:

```typescript
const foreign = ForeignAccount.private(account);
```

The account must be private. Passing a public account throws.

## Prefetched

The caller supplies both the state and the inclusion witness, so nothing is fetched for the account
at execution time. Fetch the inputs with `client.transactions.foreignAccountInputs`:

```typescript
const blockNum = await client.getSyncHeight();

const inputs = await client.transactions.foreignAccountInputs(
  [ForeignAccount.public(oracleAccountId, new AccountStorageRequirements())],
  blockNum
);

const foreign = ForeignAccount.prefetched(inputs[0]);
```

### The block the inputs are pinned to

A witness opens against the account tree of exactly one block. Inputs fetched at block `N` are valid
only for a transaction whose reference block is `N`:

- against a chain anchor, the reference block is the anchor's block;
- otherwise it is the client's sync height at execution time.

So do not sync between fetching the inputs and executing. A mismatch is rejected before execution,
naming the account and the block.

Storage map keys and vault assets that the inputs don't carry are still resolved lazily during
execution.

### Why prefetch

A node stops serving account state for old blocks. A transaction pinned to an older block — one
awaiting signatures from a multisig, say — can still execute if the state it needs was captured
while the node was still serving it:

```typescript
// Pin the reference block, then fetch the foreign state at that same block.
const anchor = await client.transactions.captureAnchor(request);
const inputs = await client.transactions.foreignAccountInputs(
  [ForeignAccount.public(oracleAccountId, new AccountStorageRequirements())],
  anchor.blockNum()
);

// ... time passes, signatures are collected, the node prunes that block's state ...

// Rebuild the request with the state already in hand — same notes, so the
// anchor captured above still covers it.
const pinned = new TransactionRequestBuilder()
  .withInputNotes(noteAndArgs)
  .withForeignAccounts(
    new ForeignAccountArray([ForeignAccount.prefetched(inputs[0])])
  )
  .build();

await client.transactions.submit(wallet, pinned, { anchor });
```

Inputs also serialize, so one client can fetch them and another can execute against them:

```typescript
const bytes = inputs[0].serialize();
// ... transport ...
const restored = AccountInputs.deserialize(bytes);
const foreign = ForeignAccount.prefetched(restored);
```

`foreignAccountInputs` fetches only the accounts you give it. It does not discover the accounts a
transaction loads on its own, such as a faucet whose asset callback the transaction triggers.
