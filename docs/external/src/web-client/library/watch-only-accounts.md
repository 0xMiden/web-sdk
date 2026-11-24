---
title: Watch-Only Accounts and Witnesses
sidebar_position: 30
---

# Watch-Only Accounts and Witnesses

A watch-only account is a public on-chain account the client follows without subscribing to its note tag. Sync keeps its commitment, nonce and storage current, but notes addressed to it are not pulled.

```typescript
const account = await client.accounts.importWatched(oracleId);
```

Tracking an account's witness keeps it current: the first sync fetches it and every sync that advances the chain refreshes it, so a transaction that uses the account as a foreign account resolves its witness locally instead of asking the node:

```typescript
await client.accounts.trackWitness(oracleId); // true if it was not tracked before
await client.sync(); // fetches the witness
await client.accounts.trackedWitnesses(); // [oracleId]
await client.accounts.untrackWitness(oracleId); // true if it was tracked
```

The tracked set persists across client reopens. `trackWitness` does not validate the account: sync fails while a tracked account has no witness the node can return, so an account that is not in the account tree blocks sync until `untrackWitness` removes it.

`getStorageMapWitness(account, slotName, key)` reads the stored witness for a key of a storage map slot. The result has `get(key)` for the value and `root()` for the map root.
