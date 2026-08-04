---
title: useCreateNetworkNote
sidebar_position: 10
---

# useCreateNetworkNote

Build and submit a Public custom-script note carrying a `NetworkAccountTarget`
attachment, so a public network account auto-consumes it once the note lands
on-chain.

```tsx
import { useCreateNetworkNote } from "@miden-sdk/react";

function CreateNetworkNoteButton() {
  const { createNetworkNote, result, isLoading, stage, error, reset } =
    useCreateNetworkNote();

  const handleCreate = async () => {
    try {
      const { txId, note } = await createNetworkNote({
        accountId: senderId,
        target: networkAccountId,
        script: myNoteScript, // or: recipient: myRecipient
      });
      console.log("Submitted", txId, note.isNetworkNote()); // true
    } catch (err) {
      console.error("Failed to create network note:", err);
    }
  };

  return (
    <div>
      {error && <div>Error: {error.message}</div>}
      <button onClick={handleCreate} disabled={isLoading}>
        {isLoading ? `${stage}...` : "Create network note"}
      </button>
      {result && <div>Sent! TX: {result.txId}</div>}
    </div>
  );
}
```

`createNetworkNote({ accountId, target, script | recipient, ... }) → { txId, note }`.
Provide exactly one of `script` or `recipient` — passing both, or neither,
throws. The note is always `NoteType.Public`; check `note.isNetworkNote()` to
confirm classification.

## Options

| Field | Type | Description |
|---|---|---|
| `accountId` | `AccountRef` | Account that creates, funds, and submits the note (hex or bech32). |
| `target` | `AccountRef` | The network account the note targets. |
| `executionHint` | `NoteExecutionHint` | Optional. Defaults to `always`. |
| `script` | `NoteScript` | Custom consumption script; the recipient is built for you. |
| `recipient` | `NoteRecipient` | Advanced: a pre-built recipient (mutually exclusive with `script`). |
| `inputs` | `bigint[]` | Note storage / inputs the script reads (used with `script`). |
| `assetId` / `amount` | `AccountRef` / `bigint \| number` | Optional single asset to lock into the note. |
| `attachment` | `bigint[] \| Uint8Array \| number[]` | Extra attachment payload appended after the required `NetworkAccountTarget`. |

## See also

- [Network notes](../../web-client/library/network-notes.md) — the underlying `MidenClient` resource method and concept overview.
