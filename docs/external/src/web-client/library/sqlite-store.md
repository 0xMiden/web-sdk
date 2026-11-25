---
title: SQLite store
sidebar_position: 80
---

# SQLite store

By default a browser client keeps its store and its keys in IndexedDB. With
`storeBackend: "sqlite"` it keeps them in SQLite databases in the origin
private file system (OPFS) instead. This is the same store the Node.js binding
uses, built for the browser.

```typescript
// Inside a dedicated Web Worker.
import { MidenClient } from "@miden-sdk/miden-sdk/mt/lazy";

await MidenClient.ready();
const client = await MidenClient.create({
  rpcUrl: "testnet",
  storeName: "wallet",
  storeBackend: "sqlite",
});
```

`MidenClient.createMock({ storeBackend: "sqlite" })` takes the same option.

## Requirements

- **The multi-threaded build.** Only `@miden-sdk/miden-sdk/mt` and
  `@miden-sdk/miden-sdk/mt/lazy` include the SQLite store, so the page has to
  be cross-origin isolated. On the single-threaded entry points client creation
  rejects with `This build of the SDK has no SQLite store`.
- **A dedicated Web Worker.** OPFS only gives a dedicated worker the
  synchronous file access SQLite needs. Create the client inside one; on the
  page, or in a shared or service worker, client creation rejects.
- **One worker per origin.** The worker that opens a SQLite store holds the
  files of every SQLite store of the origin until the worker terminates. While
  it does, client creation rejects in any other worker or tab of that origin.
  `client.terminate()` closes the client, but it is the worker ending that
  releases the files.

## What changes inside the worker

The client runs its WASM calls on the worker's own thread, without the worker
shim it starts by default: `useWorker` is treated as `false`. The shim's worker
would be a second WASM instance, and only one instance can hold the files.

Because there is no shim, proving runs single-threaded unless you start the
thread pool in that worker yourself, before creating the client:

```typescript
import { MidenClient, initThreadPool } from "@miden-sdk/miden-sdk/mt/lazy";

await MidenClient.ready();
await initThreadPool(navigator.hardwareConcurrency);
const client = await MidenClient.create({
  rpcUrl: "testnet",
  storeBackend: "sqlite",
});
```

The rest of the page talks to the client through your own messages to the
worker; objects such as `Account` live in the worker's WASM instance and cannot
be posted across.

## Several clients on one store

Clients created in the same worker on the same `storeName` share one connection
to the store, so a second client, such as a separate reader, is safe. Each
query runs to completion before the next one starts, whichever client asked.
The store stays open until the last of those clients is terminated.

If a WASM call traps, terminate the worker and start a new one rather than
replacing the client inside it: the trapped call can leave the shared
connection locked, and every later query on that store in the same worker then
fails.

## Browser extensions

A Manifest V3 service worker cannot open the store, and cannot start the
dedicated worker that could. Start the worker from an offscreen document
instead, and route requests from the service worker, the popup and other
extension pages to it.

## Where the data is

Each store is two SQLite databases, `<storeName>.sqlite3` for the store and
`<storeName>.keystore.sqlite3` for the keys and the accounts they belong to.
Both are kept in the OPFS directory `miden-client-sqlite`, under names OPFS
chooses rather than their own. `client.storeIdentifier()` returns the store's
path there, `/<storeName>.sqlite3`.

An IndexedDB store and a SQLite store of the same `storeName` are separate
stores. Nothing is moved from one to the other, so a client that switches
backend starts from an empty store.

## Export and import

`exportStore` and `importStore` read and write IndexedDB stores only. A SQLite
store has its own pair, which work on the two database files as they are:

```typescript
import {
  MidenClient,
  exportSqliteStore,
  importSqliteStore,
} from "@miden-sdk/miden-sdk/mt/lazy";

await MidenClient.ready();

// { store: Uint8Array, keystore: Uint8Array }
const dump = await exportSqliteStore("wallet");

await importSqliteStore("wallet", dump.store, dump.keystore);
```

Both run in the dedicated worker, like the client. `exportSqliteStore` can run
while clients of that worker have the store open. `importSqliteStore` replaces
the store, or creates it, and rejects while a client has it open: terminate
the client first. The files are checked by opening them as a client would,
which also brings a store exported by an older SDK up to date; if they do not
open, the import rejects and the store is left as it was.

`store` is an ordinary SQLite database, the same file the Node.js binding and
the Miden CLI keep.

With an external keystore (`keystore: { getKey, insertKey, sign }`), secret
keys stay with your callbacks, as they do on IndexedDB. Only the record of
which account each key belongs to is kept in the keystore database.

## Support

The SQLite store is exercised in Chromium. Other browsers are untested.
