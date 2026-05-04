[**@miden-sdk/miden-sdk**](../README.md)

***

[@miden-sdk/miden-sdk](../README.md) / BatchOperation

# Type Alias: BatchOperation

> **BatchOperation** = \{ `amount`: `number` \| `bigint`; `kind`: `"send"`; `reclaimAfter?`: `number`; `timelockUntil?`: `number`; `to`: [`AccountRef`](AccountRef.md); `token`: [`AccountRef`](AccountRef.md); `type?`: [`NoteVisibility`](NoteVisibility.md); \} \| \{ `amount`: `number` \| `bigint`; `kind`: `"mint"`; `to`: [`AccountRef`](AccountRef.md); `type?`: [`NoteVisibility`](NoteVisibility.md); \} \| \{ `kind`: `"consume"`; `notes`: [`NoteInput`](NoteInput.md) \| [`NoteInput`](NoteInput.md)[]; \} \| \{ `kind`: `"swap"`; `offer`: [`Asset`](../interfaces/Asset.md); `paybackType?`: [`NoteVisibility`](NoteVisibility.md); `request`: [`Asset`](../interfaces/Asset.md); `type?`: [`NoteVisibility`](NoteVisibility.md); \} \| \{ `foreignAccounts?`: ([`AccountRef`](AccountRef.md) \| \{ `id`: [`AccountRef`](AccountRef.md); `storage?`: `AccountStorageRequirements`; \})[]; `kind`: `"execute"`; `script`: `TransactionScript`; \} \| \{ `kind`: `"custom"`; `request`: [`TransactionRequest`](../classes/TransactionRequest.md); \}

A single operation inside a transaction batch. The shape mirrors the
singular options types (`SendOptions`, `MintOptions`, ...) minus the
`account` field — the executing account is set once at the batch level
and shared by every operation (V1 single-account constraint).

## Union Members

### Type Literal

\{ `amount`: `number` \| `bigint`; `kind`: `"send"`; `reclaimAfter?`: `number`; `timelockUntil?`: `number`; `to`: [`AccountRef`](AccountRef.md); `token`: [`AccountRef`](AccountRef.md); `type?`: [`NoteVisibility`](NoteVisibility.md); \}

***

### Type Literal

\{ `amount`: `number` \| `bigint`; `kind`: `"mint"`; `to`: [`AccountRef`](AccountRef.md); `type?`: [`NoteVisibility`](NoteVisibility.md); \}

***

### Type Literal

\{ `kind`: `"consume"`; `notes`: [`NoteInput`](NoteInput.md) \| [`NoteInput`](NoteInput.md)[]; \}

***

### Type Literal

\{ `kind`: `"swap"`; `offer`: [`Asset`](../interfaces/Asset.md); `paybackType?`: [`NoteVisibility`](NoteVisibility.md); `request`: [`Asset`](../interfaces/Asset.md); `type?`: [`NoteVisibility`](NoteVisibility.md); \}

***

### Type Literal

\{ `foreignAccounts?`: ([`AccountRef`](AccountRef.md) \| \{ `id`: [`AccountRef`](AccountRef.md); `storage?`: `AccountStorageRequirements`; \})[]; `kind`: `"execute"`; `script`: `TransactionScript`; \}

***

### Type Literal

\{ `kind`: `"custom"`; `request`: [`TransactionRequest`](../classes/TransactionRequest.md); \}

#### kind

> **kind**: `"custom"`

Escape hatch for pre-built TransactionRequests.

#### request

> **request**: [`TransactionRequest`](../classes/TransactionRequest.md)
