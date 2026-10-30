---
title: Input Note Queries
sidebar_position: 15
---

# Input Note Queries

Use `notes.listPage` to enumerate a browser store with a bounded raw-row scan, or
`notes.list({ detailsCommitments })` to retrieve notes whose details commitments
you already know. Both read local input-note state. They do not fetch chain state,
retain a backup, gate note acquisition or implement a wallet recovery journal.

## Bounded browser pages

```typescript
import { MidenClient } from "@miden-sdk/miden-sdk";

const client = await MidenClient.createTestnet({
  feeFaucetId: FEE_FAUCET,
  autoSync: false,
  indexedDb: { durability: "strict" },
});

const page = await client.notes.listPage({ limit: 128 });
const followingPage = page.exhausted
  ? null
  : await client.notes.listPage({
      afterDetailsCommitment: page.nextCursor,
      limit: 128,
    });
```

The public signature is
`notes.listPage(query?: InputNotePageQuery): Promise<InputNotePage>`.
The plain result contains `notes: InputNoteRecord[]`, `nextCursor: string | null`
and `exhausted: boolean`. Omitted options scan from the start across all states,
matching the state scope of `notes.list()`.

| Option | Meaning |
| --- | --- |
| `limit` | Positive safe integer from 1 to 256; defaults to 128. Bounds raw rows scanned before state filtering, not a target number of returned notes. |
| `states` | Optional array of `"consumed"`, `"committed"`, `"expected"`, `"processing"` or `"unverified"`. Omission selects all states; `[]` and unknown states reject. Repeated states are harmless. |
| `afterDetailsCommitment` | Exclusive primary-key cursor. Omitted or `null` starts the scan. Use a canonical lowercase `0x`-prefixed 32-byte details commitment, not a `NoteId`. Invalid encodings or field elements reject. |

`processing` includes both processing states. State filtering happens **after**
scanning up to `limit` raw input-note rows, so a page may contain fewer notes than
the limit, including zero. Exhaustion examines at most one further lookahead key;
it does not scan all remaining rows looking for a matching state.

`nextCursor` is the last raw key scanned, even when every scanned row was filtered
out. A page that scanned no rows retains the supplied cursor, or `null` when none
was supplied. Continue while `exhausted` is false; do not stop because `notes` is
empty and do not derive the cursor from a returned note's ID:

```typescript
const page = await client.notes.listPage({
  states: ["expected", "unverified", "committed", "processing"],
  afterDetailsCommitment: savedCursor,
  limit: 128,
});

// Save this cursor even when page.notes.length is zero.
savedCursor = page.nextCursor;
const hasMoreRawRows = !page.exhausted;
```

Pages use ascending `detailsCommitment` primary-key order and resume strictly
after the cursor value, even if the cursor's row was deleted. Partial or
metadata-less records need no `NoteId` or metadata for enumeration; selected rows
use the existing SDK decoder. Decode or storage failures reject the call rather
than reporting successful exhaustion.

A bounded call does not provide a snapshot across pages. Concurrent imports,
deletions, state changes or rollback can change what a later page sees; a row
inserted before the cursor will not appear in that continuation. Applications
requiring a complete baseline must coordinate mutations and validate their own
generation/checkpoint before accepting it. The cursor is neither a generation
marker nor a proof that every relevant note was retained.

This API is browser-only. It uses the client's already-open IndexedDB store and
works on eager/lazy and ST/MT entries. With `useWorker: true`, it runs through the
serialized main-WASM fallback, rather than transferring record handles through
the method worker. Native Node/SQLite explicitly rejects `listPage`; it does not
silently return an empty page or fall back to an unbounded SQLite scan.

## Look up known details commitments

```typescript
const records = await client.notes.list({
  detailsCommitments: [detailsCommitmentHex, detailsCommitmentWord],
});
```

`detailsCommitments` accepts an array of hex strings or `Word` instances and maps
to the existing native `NoteFilter::DetailsCommitments`. It uses indexed lookup
for the supplied commitments across all states, including consumed records. It
can retrieve metadata-less records without a note ID. An empty array returns no
records.

This filter is mutually exclusive with `status`, `ids` and `scriptRoots`; a mixed
query rejects. Unlike browser paging, this lookup is supported by both browser
and native Node backends. It does not materialize unrelated notes, but its result
size follows the commitments supplied by the caller; it has no page limit.
Existing `notes.list()` defaults and other filters remain unchanged.

## Recovery boundaries

These enumeration and lookup APIs are separate from the opt-in
[awaited acquisition gate](./note-acquisition.md). They do not provide an encrypted
journal or backup promotion.
Bounded pages let an application inspect a large public-note population before
applying its own retention rules, but the SDK does not decide which records are
recovery-critical or whether an incomplete scan is safe to accept.

For per-connection durability hints and storage-failure callbacks, see
[IndexedDB Safety](./indexeddb-safety.md). Strict remains a browser hint with the
same limitations; it does not make a multi-page scan atomic.
