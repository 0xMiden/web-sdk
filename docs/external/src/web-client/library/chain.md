---
title: Chain data
sidebar_position: 66
---

# Read block headers and nullifiers

`client.chain` reads chain data from the node without touching the local store.
It uses the client's own endpoint through one cached `RpcClient`, so it answers
while a sync or transaction is in flight. On a mock client, which has no node,
and after `terminate()`, every call rejects. For node calls it does not cover,
use the standalone [`RpcClient`](./rpc-client.md).

```typescript
const client = await MidenClient.createTestnet();

const tip = await client.chain.getBlockHeader(); // latest block
const { header, mmrProof } = await client.chain.getBlockHeaderWithProof(100);
```

## Block headers and MMR proofs

`getBlockHeader(blockNum?)` returns the header of a block, or of the latest
block when `blockNum` is omitted. `getBlockHeaderWithProof(blockNum)` also
returns the `MmrProof` that the block's commitment is a leaf of the chain's
MMR. The proof is made against the chain length the node reports,
`mmrProof.forest()`, which can be later than the block. It exposes `leaf()`,
`position()`, `forest()`, `peakIndex()` and `merklePath()`.

## Nullifiers

`getNullifierCommitHeights(nullifiers, { blockFrom })` scans from `blockFrom`
(default 0) to the chain tip and returns a `Map` from each requested
nullifier's hex to the block that consumed it, or `null` when none did. It
compares full nullifiers, so a shared prefix cannot produce a false match.
Pass `Word`s (never consumed) or 0x-prefixed hex strings of any case; the map is keyed by what you passed.

```typescript
const heights = await client.chain.getNullifierCommitHeights([nullifierHex]);
if (heights.get(nullifierHex) !== null) {
  // consumed
}
```

`syncNullifiers(prefixes, blockFrom, blockTo)` returns every
`NullifierUpdate` whose nullifier matches one of the 16-bit prefixes in the
inclusive range. A prefix outside 0 to 65535 or a non-integer throws a `RangeError`. Prefixes can match unrelated notes, so compare the returned
`nullifier()` with the one you track.

The standalone `RpcClient` has the same reads: `getBlockHeaderWithProof`,
`getNullifierCommitHeights(nullifiers, blockFrom)` and `syncNullifiers`. On the
browser entries the `Word`s passed to `RpcClient.getNullifierCommitHeights` are
consumed; `client.chain` copies them for you.
