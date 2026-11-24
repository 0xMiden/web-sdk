---
title: One client per store
sidebar_position: 70
---

# One client per store

Two live clients on one store do not coordinate with each other, so keep one
client per store. Opening a store that another live client in the same realm
has open (the same IndexedDB database in the browser, the same SQLite file on
Node.js) logs a `console.warn` naming that client as `client #N`, numbered in
the order clients opened the store.

Pass `exclusive: true` to refuse instead. The open throws an error naming the
client that has the store, and while an exclusive client lives every other open
of its store throws too.

```typescript
const owner = await MidenClient.create({
  rpcUrl: "testnet",
  storeName: "app",
  exclusive: true,
});

// Throws: Store "app" is already open in client #1 ...
await MidenClient.create({ rpcUrl: "testnet", storeName: "app" });

owner.terminate(); // releases the store; the next open succeeds without a warning
```

`terminate()`, `using` and `await using` release the store. An open that fails
holds no claim on it.
