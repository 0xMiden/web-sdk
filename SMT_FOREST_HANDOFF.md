# Account SMT forest persistence in IndexedDB: status and handoff

Branch `jere-idxdb-forest-persistence`. The implementation is complete, reviewed, and green, but it depends on an upstream chain that has not merged yet (see "Dependency chain" below), so no PR is open. This document is the handoff for whoever continues the work; delete it (and `bench-forest/`) from the branch before opening the eventual PR.

## What this branch does

Ports rust-sdk PR [0xMiden/rust-sdk#2333](https://github.com/0xMiden/rust-sdk/pull/2333) to the IndexedDB store. The account SMT forest (one sparse Merkle tree per account vault and per storage map slot, used to serve asset and storage witnesses) previously lived only in memory. It was rebuilt from the IndexedDB tables on every client open, so open time and wasm memory grew linearly with total tracked state. This branch persists the trees in four new Dexie tables (per-lineage metadata, tree entries, 8-level subtree blobs, and a monotonic revision counter), and each store operation loads only the rows it needs.

## How it works

IndexedDB is asynchronous while the forest `Backend` contract is synchronous, so every store operation runs in three phases. First it enumerates the rows it will read using the shared prefetch planner and loads them asynchronously into a strict row cache (any read the planner missed fails loudly instead of returning a wrong empty value). Then the shared row backend (`miden_client::store::forest_backend`, extracted from the sqlite store) runs synchronously against that cache, recording writes instead of persisting them. Finally the recorded delta crosses the wasm boundary once as a plain serialized object and is written inside the same Dexie transaction as the operation's account writes.

Concurrency is optimistic. The write transaction re-validates every touched lineage (version, root, entry count, or expected absence for additions), the revision counter, and the account base state (expected initial commitment for local transaction results, strictly increasing nonce for network updates) before writing anything. Row prefetches also carry the snapshot revision so torn reads surface as typed `ForestConflictError`s. Conflicts restart the whole operation from a fresh snapshot with a bounded retry, while genuine base-state divergence (`StaleAccountBaseError`) is terminal. State sync applies the undo, the full account updates, the incremental patches, and one reconciled forest delta in a single transaction, and re-validates the resolved post-undo account states inside it so a concurrent history prune cannot desynchronize account rows from the forest.

## Benchmarks

Measured in headless Chromium (Playwright) against a `next` build (`bed3609`), one account holding a storage map with N entries. Everything lives in `bench-forest/`: the A/B harness (`run-bench.mjs`), the raw-IndexedDB throughput probe (`idb-throughput.mjs`), the per-table disk attribution script (`disk-breakdown.js`), the raw result JSONs, and the full results page with methodology (`results.html`; render it via `https://htmlpreview.github.io/?` plus the file's raw GitHub URL, or open it locally).

| Metric | N=1k | N=10k | N=50k |
|---|---|---|---|
| Client open (next -> this branch) | 315 ms -> 38 ms | 2.93 s -> 36 ms | 14.75 s -> 37 ms |
| Witness read, warm median | 0.30 -> 1.25 ms | 0.25 -> 1.20 ms | 0.30 -> 1.20 ms |
| Transaction (execute + prove) | 3.12 s -> 3.01 s | n/a | n/a |
| Bulk insert (account creation) | 0.20 s -> 1.47 s | 3.95 s -> 46.6 s | 43.2 s -> 372.7 s |
| Disk (`navigator.storage.estimate`) | 1.45 -> 4.29 MB | 3.96 -> 63.8 MB | 29.2 -> 298.8 MB |

Opening the client goes from linear in total state to flat ~37 ms, witness reads stay near-constant at ~1 ms regardless of map size, and ordinary transactions are unaffected (proving dominates; incremental patches touch a handful of rows). The trade-off moved to bulk writes and disk, the same trade the sqlite store made. Persisting a tree means writing ~6-7 subtree rows per entry, and IndexedDB sustains only ~1,500-2,300 record writes per second in Chromium regardless of record size, transaction durability, or index count (measured with the raw probe, which bypasses all SDK code), so creating an account whose map has tens of thousands of entries is 7-12x slower than before. Serialization strategy, base64 removal, and adjacent-position subtree packing were each prototyped and measured; none of them moves this, since hashed keys make subtree positions sparse and the cost is per record. The lever that would recover most of the write and disk cost is skipping persistence of single-leaf subtrees and reconstructing them from their entry at read time, which needs support in the shared `forest_backend` module and would equally shrink the sqlite store's 23-25x disk footprint, so it is left as a follow-up.

## Dependency chain

This branch is the last link of a chain and cannot merge before it:

1. **miden-vm**: `Subtree` is currently only exported under the `concurrent` feature (rayon), which does not exist on wasm/no_std. The fix (move `SUBTREE_DEPTH` up and compile the subtree module standalone when `concurrent` is off) is commit `e8dc3b46` on [`JereSalo/miden-vm#client-pin-from-parts-0.28`](https://github.com/JereSalo/miden-vm/tree/client-pin-from-parts-0.28) and needs its own miden-vm PR plus a crypto release. It is independent of miden-vm#3413, which can merge as is.
2. **rust-sdk #2333**: the sqlite forest persistence this ports.
3. **rust-sdk branch `jere-forest-row-backend`**: extracts the sqlite backend into the shared public module `miden_client::store::forest_backend` (row-store trait, backend, prefetch planner) that this store implements against. The branch is complete and green (lint plus 292 tests), stacked on #2333, and needs its own PR once #2333 merges.

Until those land in releases, `Cargo.toml` here temporarily patches `miden-client`/`miden-client-sqlite-store` to the rust-sdk branch and the crypto crates to the miden-vm fork branch. Remove the `[patch.crates-io]` block and regenerate the lockfile before merging.

## State of the work

- Design and implementation were adversarially reviewed in two full passes; all 14 findings (2 critical) were fixed and re-verified with no remaining findings.
- Green locally: 362 idxdb-store vitest tests (~98% coverage), `make clippy-wasm`, `make check-wasm`, tsc, eslint, prettier. `make lint` additionally runs `web-client-check-methods`, which requires a full `dist/` build.
- The DB schema adds the four forest stores directly to `V1_STORES` (no migration): releases from `next` always bump the minor version and the client resets the database on version change. Development databases created before this branch must be deleted manually.
- Store dumps (export/import) include the forest tables; the dump format version is unchanged since none shipped.

## Follow-ups for whoever continues

- Open the miden-vm PR for the `Subtree` export fix (cherry-pick `e8dc3b46`), then the rust-sdk PR for `jere-forest-row-backend` after #2333 merges, then repoint this branch's pins and drop them as releases land.
- Singleton-subtree persistence skip (shared `forest_backend` change, recovers most of the bulk-write and disk cost above).
- `update_account` full-state reconciliation still reads the account's complete entry set to compute the diff (same documented limitation as sqlite's `update_account`).
- The mock chain does not register SDK-created accounts as committed, which caps transaction benchmarks at ~1k-entry maps (first tx carries full state and exceeds the protocol update-size limit); integration-level benchmarks against a real node would remove that cap.
- Before the eventual PR: remove this file and `bench-forest/` from the branch (or move the benchmarks to a companion branch), add the CHANGELOG entry, and write the PR description from this document.
