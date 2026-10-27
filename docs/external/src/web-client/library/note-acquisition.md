# Awaited note acquisition

Configure `beforeNoteAcquisition` with `noteAcquisitionLimits` when creating a browser
client or mock client. The SDK awaits one `Promise<void>` receipt per candidate before
native common-import writes and note-transport cursor advancement. Absent configuration
preserves default behavior. Native Node rejects these options before creating files.

```ts
const client = await MidenClient.create({
  beforeNoteAcquisition: async (candidate) => {
    await retainEncryptedCandidateAndReadBack(candidate);
  },
  noteAcquisitionLimits: {
    maxNotes: 64,
    maxNoteFileBytes: 262144,
    maxTotalNoteFileBytes: 1048576,
  },
});
```

The application supplies `retainEncryptedCandidateAndReadBack` and its independent
storage. Do not call the locked client from this callback. Check the owning vault,
network and epoch before retention and again before resolving. Preserve previous good
retained generations when refusing a later unverified candidate. Successful retention
is not authentication of a candidate's inclusion proof or network state.

`NoteAcquisitionCandidate` contains copied `Uint8Array` NoteFile bytes, variant, source,
operation ID, batch position, and optional actual identity, metadata and hints. An
ExpectedNote has a details commitment and sync hint but no note ID, metadata or nullifier.
NoteId-only files have no private body. These absences are preserved across worker IPC.
Method-worker requests carry the owning operation ID and await its matching response.
Termination, worker loss, invalid acknowledgements and expired operations refuse success.
Raw browser WASM users can install `installNoteAcquisitionGate` before exposing a client;
its Promise must resolve a sanitized `accepted`, `rejected` or `retentionFailed` decision.

All three limits are required nonnegative u32 integers. Zero refuses nonempty input.
They cap note count and per-item/aggregate delivered encoded bytes, including copied IPC
payloads. The existing native encoder allocates before checking encoded size, so this
API does not promise a strict pre-allocation memory ceiling or bounded whole-batch encoding.

Generic throws and invalid callback results map to `NOTE_ACQUISITION_REJECTED`. Only throw
`NoteAcquisitionRetentionError` for a known independent write, readback or continuity
failure; it maps to `NOTE_ACQUISITION_RETENTION_FAILED`. Configured limits map to
`NOTE_ACQUISITION_LIMIT_EXCEEDED`. Thrown messages, stacks and arbitrary values are never
sent across the acquisition channel. Later native processing errors retain their ordinary
import category. A refusal does not imply IndexedDB corruption or change storage policy.

Strict IndexedDB remains a browser durability hint. See [IndexedDB safety](./indexeddb-safety.md).
