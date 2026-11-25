---
title: IndexedDB Safety
sidebar_position: 25
---

# IndexedDB Safety

Browser clients can request a transaction durability hint and receive contextual
storage failure notifications with `indexedDb`. Existing calls that omit it keep
their existing behavior. The same options work with all four browser entry points
(eager/lazy and ST/MT), external keystores and `MidenClient.createMock()`.

```typescript
import { MidenClient, type IndexedDbFailure } from "@miden-sdk/miden-sdk";

let localFailure: IndexedDbFailure | undefined;
const client = await MidenClient.createTestnet({
  feeFaucetId: FEE_FAUCET,
  storeName: "my-wallet",
  autoSync: false,
  indexedDb: {
    durability: "strict",
    onFailure(failure) {
      localFailure = failure;
    },
  },
});

const storeName = await client.storeIdentifier();
const generation = await client.settings.get<number[]>("wallet.generation");
```

`autoSync: false` lets the application inspect its own recovery state before
starting sync. This is not a write gate: opening can migrate or stamp the store,
and the application still owns authorization of later operations. The example
only records a failure locally; it does not implement wallet recovery or decide
whether a financial operation is safe.

## Durability and shared connections

`durability` accepts `"default"`, `"strict"` or `"relaxed"`, using the browser's
IndexedDB transaction durability hint. Strict asks the browser to favor durable
writes before acknowledging completion. It is not a physical-integrity guarantee
and does not prevent eviction, corruption, rollback or data loss. Browser support
and behavior vary. Schema-upgrade transactions are managed during database open;
this option cannot retroactively configure their durability.

One shared connection, including a pending open, has one policy. An omitted
`durability` inherits that connection's policy; an explicit conflicting value
rejects with `TypeError` without changing another holder's policy. With no
existing policy, omission keeps the browser default. `"default"` is an explicit
value and conflicts with an existing strict or relaxed policy. Callbacks belong
to individual holders and are released when their client terminates; terminating
one holder does not unsubscribe its siblings.

Connection sharing is local to a JavaScript realm. The SDK forwards a client's
policy to its method worker, but unrelated clients in other workers or tabs must
each opt in. A strict client does not silently upgrade other realms.

## Failure callback contract

`onFailure` runs synchronously before the failing operation settles. In worker
mode the worker sends the notification before its result, and the main realm
invokes your callback before delivering that result. Keep the callback short and
synchronous; a returned promise is not awaited. Throwing from it does not replace
the operation's original result or rejection. A failure can occur during creation,
before a client handle is returned. Delivery stops when the client terminates.

The frozen `IndexedDbFailure` object contains exactly these fields:

| Field | Values or meaning |
| --- | --- |
| `backend` | `"indexeddb"` |
| `storeName` | Database name for local routing; treat it as private |
| `phase` | `"open"`, `"read"`, `"write"` or `"commit"` |
| `operation` | `"indexeddb.open"`, `"indexeddb.read"`, `"indexeddb.write"` or `"indexeddb.commit"`, matching `phase` |
| `kind` | `"quota"`, `"io"`, `"unavailable"` or `"unexpected-abort"` |
| `errorName` | `"QuotaExceededError"`, `"UnknownError"`, `"SecurityError"`, `"InvalidStateError"`, `"MissingAPIError"` or `"AbortError"` |
| `eventId` | Connection-scoped deduplication identifier, at most 128 characters |

Quota maps to `QuotaExceededError`; `UnknownError` maps to `io` at the native
storage boundary. Security, invalid-state and missing-API failures map to
`unavailable`; a native abort without a more specific cause maps to
`unexpected-abort`. These categories describe the observed failure, not forensic
proof of disk damage or a diagnosis of all possible data loss. An empty callback
history is not evidence of intact data.

Request errors distinguish reads from writes, even inside a write transaction.
`commit` covers a native abort after requests succeeded: successful requests alone
do not mean a transaction committed. The original rejection and transaction
atomicity are preserved. Normal input/validation errors, deliberate rollback and
an unrelated `AbortError` outside IndexedDB do not produce storage-health events.

A transaction reports its storage failure once. A client wrapper also retains a
bounded set of the latest 64 event IDs to suppress duplicate delivery from
overlapping holders. This is not a persistent event log, a global identifier or
permanent exactly-once delivery; independent clients have independent callbacks.

The envelope has no arbitrary messages, stacks, table names, record keys,
account-ID fields or stored values. Database names can still identify an application
or user namespace. Keep `storeName` and `eventId` in local routing state unless
your own privacy policy permits export. The SDK does not automatically forward
these events to observations, telemetry, Sentry or logs. The callback adds no
retry, reset, repair or wallet financial policy.

## Full-store export and import

Standalone browser helpers accept the same options as a trailing argument:

```typescript
import { exportStore, importStore } from "@miden-sdk/miden-sdk";

const indexedDb = { durability: "strict" as const, onFailure: handleLocalFailure };
const dump = await exportStore(storeName, indexedDb);
await importStore(storeName, dump, indexedDb);
```

These helpers acquire their own holder for the operation and obey the same
shared-connection conflict rules. `importStore` replaces the entire store and
retains its existing version validation. It is an explicit destructive restore,
not an automatic response to a storage notification. Coordinate other clients
before restoring and keep dumps private: unlike the failure envelope, a dump
contains stored data, including key material.

## Wallet-owned generation markers

`storeIdentifier()` returns a namespace, not a database incarnation. A database
can be deleted and recreated under the same name. The SDK adds no generation API
and never automatically creates, changes or removes a wallet generation marker.

Use the existing USER settings surface for a wallet-owned marker. Settings hold
bytes; for example, during an explicitly authorized new-wallet provisioning step:

```typescript
const markerBytes = Array.from(new TextEncoder().encode(walletGeneration));
await client.settings.set("wallet.generation", markerBytes);
```

The startup example reads the marker without replacing it. A missing or changed
marker must enter the wallet's recovery policy rather than being silently
initialized. A matching marker is insufficient: full-store import and rollback
copy it along with the data, and partial loss can leave the marker while removing
accounts. Compare the accounts you expect using expectations retained by the
wallet outside the store under examination. Missing expected accounts also
require wallet recovery. Generation expectations, write gating, recovery journals,
backup retention and decisions about pending transactions belong to the wallet.

## Mock and low-level construction

`MidenClient.createMock({ indexedDb, useWorker: false })` applies the same browser
policy while selecting direct execution. Omit `useWorker` for the normal worker
path. The mock chain is in memory; its browser store still uses IndexedDB.

For the JavaScript `WasmWebClient` wrapper, `createClient` and
`createClientWithExternalKeystore` append `indexedDb` after the existing
`noteTransportRetryIntervalMs` argument. Their earlier positional arguments do
not move. `MockWebClient.createClient` appends `indexedDb` and then `useWorker`
after `logLevel`.

For a raw WASM instance obtained from `getWasmOrThrow()`, the trailing options
argument is the eighth argument of `createClient`, the eleventh of
`createClientWithExternalKeystore`, and the fourth of `createMockClient`:

```typescript
import { getWasmOrThrow } from "@miden-sdk/miden-sdk";

const wasm = await getWasmOrThrow();
const raw = new wasm.WebClient();
await raw.createClient(
  rpcUrl, noteTransportUrl, undefined, storeName, feeFaucetId,
  undefined, undefined, indexedDb,
);
```

Keep existing raw-WASM lifetime and serialization requirements. This direct call
does not create a method worker.

Node.js uses SQLite rather than IndexedDB. The public normal, external-keystore
and mock construction paths reject an explicit `indexedDb` value, including
`{}`, with `TypeError` before creating database/keystore files or constructing
the native client. Omit the option on Node; it is not a SQLite durability control.
