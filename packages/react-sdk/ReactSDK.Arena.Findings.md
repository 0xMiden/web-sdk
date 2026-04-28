# Miden React SDK Improvements — Learnings from miden-arena

## Context

The miden-arena game (P2P on-chain combat) is a real-world stress test of `@miden-sdk/react`. It exposed systemic pain points that will affect every dApp built on the SDK. This plan proposes concrete, additive improvements to the React SDK to eliminate the most costly workarounds, with emphasis on making the SDK usable by both humans and LLMs.

**Source of truth**: miden-arena at `~/miden/miden-arena`, React SDK at `~/miden/miden-client/packages/react-sdk`

---

## Pain Point Summary

| # | Pain Point | Arena Workaround | Boilerplate |
|---|-----------|-----------------|-------------|
| 1 | No temporal note tracking ("new since phase X") | `handledNoteIds` ref + deferred baseline + stale ID snapshots, repeated 3x | ~150 lines |
| 2 | Dual-track notes (summaries vs raw records) | `useNoteDecoder` (146 lines) bridging NoteSummary ↔ InputNoteRecord | 146 lines |
| 3 | No attachment support in `useSend()` | Manual `TransactionRequestBuilder` + 12 WASM types per send | ~30 lines/send |
| 4 | Session wallet flow is 378 lines | 5-step state machine across 5 useEffects | 378 lines |
| 5 | WASM pointer consumption is silent footgun | "Create fresh AccountId each iteration" comments, `parseId()` helpers | Bugs |
| 6 | Manual `runExclusive()` required | Wrapping every direct client call; forgetting = intermittent corruption | Bugs |
| 7 | React StrictMode breaks MidenProvider | Removed StrictMode entirely | Compatibility |
| 8 | No sender filter in `useNotes()` | Manual `.filter(n => n.sender === opponentId)` everywhere | ~20 lines/hook |
| 9 | Attachment reading is 5-step chain | Custom `readAttachment()` helper | 20 lines |
| 10 | ID format mismatch (hex vs bech32) | `parseId()` try/catch, ID set cross-referencing | Bugs |
| 11 | No pre-send sync | `await sync()` before every send (6 call sites) | 6 lines |
| 12 | No IndexedDB migration story | Custom 53-line `migrateIfNeeded()` in main.tsx | 53 lines |
| 13 | No send concurrency guard | `isSendingRef` pattern to prevent double-sends | 10 lines/hook |
| 14 | WASM class identity breaks with symlinks | Vite dedup + alias + preserveSymlinks + excludeOptimizeDeps config | 15 lines config |
| 15 | gRPC-web CORS not supported out of box | Vite proxy to `https://rpc.testnet.miden.io` | 7 lines config |
| 16 | COOP/COEP headers required for SharedArrayBuffer | Manual Vite headers + service worker for production | 10 lines config |
| 17 | No byte conversion utilities | Custom `bytes.ts` (bytesToBigInt, bigIntToBytes, concatBytes) | 34 lines |
| 18 | Wallet extension detection timing | Custom 20-line polling with timeout for `readyStateChange` | 20 lines |
| 19 | Dual-provider tree is confusing | WalletProvider + MidenProvider nesting order matters, undocumented | Confusion |
| 20 | `useNotes` refetches on every sync even if nothing changed | UI flickers, unnecessary re-renders | Perf |
| 21 | No `localStorage` persistence helpers for session state | Custom `persistence.ts` (106 lines) for wallet ID, opponent, draft state | 106 lines |
| 22 | `useSend` stage is unused (suppressed with `void stage`) | Unclear what stage reporting is for in consumer code | Confusion |
| 23 | Concurrent sends cause state commitment mismatch | Protocol test specifically demonstrates this bug; arena uses sequential awaits | Bugs |
| 24 | `useTransaction` stage `executing` is never observable | Sets `executing` then immediately `proving` with no async work between — React batches both setState calls so `executing` never renders | Inconsistency |
| 25 | No way to send "all balance" back to a wallet | Arena manually calculates withdrawal amounts based on game outcome | ~15 lines |
| 26 | Cryptic WASM errors with no actionable context | `_assertClass` failures, silent pointer consumption — error messages don't say what went wrong or how to fix it | Bugs/DX |
| 27 | `useMultiSend` lacks parity with `useSend` | If `useSend` gets attachment/auto-sync, `useMultiSend` doesn't — inconsistent capabilities | Inconsistency |

---

## Proposed SDK Changes

### 1. `useNoteStream` — Temporal Note Tracking with Unified Model
**Priority**: Critical
**Solves**: Pain points 1, 2, 8, 9, 10

The single highest-impact change. Replaces the stale-note-tracking pattern repeated 3 times in the arena.

**Problem in arena code**:
- `useMatchmaking.ts:62-78` — handledNoteIds + deferred baseline refs
- `useDraft.ts:86-87` — handledNoteIds init from staleNoteIds
- `useCommitReveal.ts:180-202` — handledNoteIds + round-boundary snapshots
- `useNoteDecoder.ts:91-108` — dual-track bridging (summaries for sender, raw records for attachments)

```typescript
// --- New type: unified note that merges summary + raw record ---

interface StreamedNote {
  /** Note ID (hex string from NoteId.toString() — note IDs are NOT account IDs and don't use bech32) */
  id: string;
  /** Sender account ID (bech32) */
  sender: string;
  /** First fungible asset amount (convenience for single-asset notes; 0n if no fungible assets) */
  amount: bigint;
  /** All assets */
  assets: NoteAsset[];
  /** The underlying InputNoteRecord for escape-hatch access */
  record: InputNoteRecord;
  /** Timestamp (ms) when this note was first observed by the SDK */
  firstSeenAt: number;
  /** Pre-decoded attachment values, or null if no attachment */
  attachment: bigint[] | null;
}

// --- New hook ---

interface UseNoteStreamOptions {
  /** Note status filter. Default: "committed" */
  status?: "all" | "consumed" | "committed" | "expected" | "processing";
  /** Only notes from this sender (any format, normalized internally) */
  sender?: string | null;
  /** Only notes first seen after this timestamp */
  since?: number;
  /** Exclude these note IDs (for cross-phase stale filtering) */
  excludeIds?: Set<string> | string[];
  /** Filter by primary asset amount */
  amountFilter?: (amount: bigint) => boolean;
}

interface UseNoteStreamReturn {
  /** Notes matching all filter criteria */
  notes: StreamedNote[];
  /** Most recent note (convenience) */
  latest: StreamedNote | null;
  /** Mark a note as handled (excluded from future renders) */
  markHandled: (noteId: string) => void;
  /** Mark all current notes as handled */
  markAllHandled: () => void;
  /** Snapshot current state for passing to next phase */
  snapshot: () => { ids: Set<string>; timestamp: number };
  isLoading: boolean;
  error: Error | null;
}

function useNoteStream(options?: UseNoteStreamOptions): UseNoteStreamReturn;
```

**Implementation in SDK**:
- `MidenStore.ts` gains `noteFirstSeen: Map<string, number>` — records `Date.now()` when each note ID first appears
- `StreamedNote` is built by merging `InputNoteRecord` + `NoteSummary` data in one pass, normalizing IDs to bech32
- Attachment is pre-decoded using the word/array detection logic (see Proposal 5 below)
- `markHandled` stores handled IDs in an internal `Set` ref, filtered out in the useMemo
- `snapshot()` returns both `ids` and `timestamp` so apps can use either `excludeIds` or `since` at phase boundaries
- When `sender` is `null`, returns empty (safe default matching arena pattern)

**Arena code eliminated**: `useNoteDecoder.ts` (146 lines), `handledNoteIds` refs in 3 hooks (~45 lines), `needsBaselineRef` pattern in 2 hooks (~40 lines), `staleNoteIds` fields in gameStore DraftState/BattleState

---

### 2. Attachment Support in `useSend()`
**Priority**: Critical
**Solves**: Pain points 3, 9

**Problem in arena code** (`useCommitReveal.ts:88-120`):
```typescript
// 30 lines of boilerplate to send a note with data:
// AccountId, FungibleAsset, NoteAssets, NoteAttachment,
// NoteAttachmentScheme, Word, Note.createP2IDNote,
// TransactionRequestBuilder, OutputNote, OutputNoteArray
```

**Proposed change** — additive fields on existing `SendOptions`:
```typescript
interface SendOptions {
  from: string;
  to: string;
  assetId: string;
  amount: bigint;
  noteType?: "private" | "public" | "encrypted";
  recallHeight?: number;
  timelockHeight?: number;
  // NEW — arbitrary data payload
  attachment?: bigint[] | Uint8Array | number[];
}
```

**Implementation in SDK** (`useSend.ts`):
- When `options.attachment` is provided, switch from `client.newSendTransactionRequest()` to manual `Note.createP2IDNote()` + `TransactionRequestBuilder` construction
- **Prerequisite**: Verify that the WASM bindings expose `Note.createP2IDNote` with a `NoteAttachment` parameter (or equivalent). If not, this requires Rust-side changes to `web-client` before the JS wrapper can be built. The arena's `sendAttachmentNote()` already does this via the existing bindings — check that path first.
- Use Word attachment for <=4 values (avoids miden-standards 0.13.x Array advice-map bug), Array for >4
- Pad arrays to 4 elements automatically for Word
- Create fresh `AccountId` objects internally (no WASM pointer leak)
- All WASM type construction is internal — apps never import `NoteAttachment`, `Word`, `TransactionRequestBuilder`, etc.

**Arena code eliminated**: `sendAttachmentNote()` helper (30 lines), 12 WASM type imports in useCommitReveal

---

### 3. Auto-Sync Before Send + Concurrency Guard
**Priority**: High
**Solves**: Pain points 11, 13

**Problem**: Arena calls `await sync()` before every single `send()` (6 call sites). Also uses `isSendingRef` pattern to prevent concurrent sends.

**Proposed change** — internal to `useSend.ts` and `useTransaction.ts`:

The complete `SendOptions` after Proposals 2, 3, and 17:
```typescript
interface SendOptions {
  from: string;
  to: string;
  assetId: string;
  amount: bigint;
  noteType?: "private" | "public" | "encrypted";
  recallHeight?: number;
  timelockHeight?: number;
  attachment?: bigint[] | Uint8Array | number[];  // Proposal 2
  skipSync?: boolean;                               // Proposal 3 (default: false)
  sendAll?: boolean;                                // Proposal 17
}
```

**Implementation**:
- `useSend()` calls `sync()` before building the transaction (unless `skipSync: true`)
- **Behavioral change note**: Existing code that already calls `sync()` before `send()` will now sync twice (harmless but wasteful). Document `skipSync: true` for those migrating.
- Add internal `isBusy` ref that prevents concurrent executions, returning a rejected promise if a send is already in-flight
- Same changes for `useTransaction().execute()`

**Arena code eliminated**: 6 `await sync()` calls, `isSendingRef` pattern in useDraft (10 lines)

---

### 4. `useSessionAccount` — Session Wallet Lifecycle
**Priority**: High
**Solves**: Pain point 4

**Problem**: `useSessionWallet.ts` is 378 lines implementing idle→connecting→creatingWallet→funding→consuming→done across 5 useEffects with cancellation, error recovery, and localStorage persistence.

```typescript
interface UseSessionAccountOptions {
  /** Callback to fund the session wallet. Receives the session wallet ID. */
  fund: (sessionAccountId: string) => Promise<void>;
  /** Asset ID of the funding token */
  assetId: string;
  /** Wallet creation options */
  walletOptions?: {
    storageMode?: "private" | "public";
    mutable?: boolean;
    authScheme?: 0 | 1;
  };
  /** Polling interval for funding note detection (ms). Default: 3000 */
  pollIntervalMs?: number;
  /** localStorage key prefix for persistence. Default: "miden-session" */
  storagePrefix?: string;
}

interface UseSessionAccountReturn {
  /** Start the create→fund→consume flow */
  initialize: () => Promise<void>;
  /** Session wallet ID (bech32), or null if not yet created */
  sessionAccountId: string | null;
  /** Whether the session wallet is funded and ready */
  isReady: boolean;
  /** Current step */
  step: "idle" | "creating" | "funding" | "consuming" | "ready";
  /** Error from any step */
  error: Error | null;
  /** Clear all session data and reset */
  reset: () => void;
}

function useSessionAccount(options: UseSessionAccountOptions): UseSessionAccountReturn;
```

**Implementation**:
- Internally uses `useCreateWallet()`, `useMiden().runExclusive`, polling via `getConsumableNotes()`
- Persists session wallet ID to localStorage; restores on page reload
- The `fund` callback is app-provided (keeps SDK agnostic to funding source: wallet adapter, faucet, etc.)
- Handles `runExclusive` wrapping of sync+check+consume internally
- Creates fresh `AccountId` per poll iteration internally (no WASM pointer leak)
- Cancellation on unmount via `cancelled` flag (same pattern as arena)

**Arena code reduced**: `useSessionWallet.ts` goes from 378 lines to ~40 (just the `fund` callback + wallet adapter connection)

---

### 5. `readNoteAttachment` / `createNoteAttachment` Utilities
**Priority**: High
**Solves**: Pain point 9 directly, supports Proposals 1 and 2

**Problem** (`useCommitReveal.ts:126-146`): Reading attachments is a 5-step chain that every app reimplements.

```typescript
// New exported utilities from @miden-sdk/react

interface NoteAttachmentData {
  values: bigint[];
  kind: "word" | "array";
}

/** Decode a note's attachment. Returns null if no attachment. */
function readNoteAttachment(
  note: InputNoteRecord
): NoteAttachmentData | null;

/** Encode values into a NoteAttachment.
 *  <=4 values → Word (avoids advice-map bug). >4 → Array. */
function createNoteAttachment(
  values: bigint[]
): NoteAttachment;
```

**Implementation**: Wraps the metadata→attachment→kind→asWord/asArray→toU64s chain. Used internally by `StreamedNote.attachment` (Proposal 1) and by the enhanced `useSend` (Proposal 2).

---

### 6. Make `client` Safe by Default
**Priority**: High
**Solves**: Pain points 5, 6
**Breaking**: Yes — `useMiden().client` changes type from `WebClient` to `MidenClient`

**Problem**: Every direct `client` call must be wrapped in `runExclusive()` to prevent WASM races. WASM pointers are silently consumed on use, requiring fresh objects per call.

**Design principle**: If the safe version is always preferable, it should just *be* the client. Don't make developers choose between a safe and unsafe option.

```typescript
// useMiden() returns a safe client wrapper as `client`
interface MidenContextValue {
  /** Safe client — auto-locks, accepts string IDs, creates fresh WASM objects internally */
  client: MidenClient | null;
  isReady: boolean;
  // ... existing fields
}

interface MidenClient {
  // --- Query methods (auto-locked, string IDs) ---
  syncState: () => Promise<SyncStateSummary>;
  getAccounts: () => Promise<AccountHeader[]>;
  getAccountById: (accountId: string) => Promise<Account | null>;
  getConsumableNotes: (accountId?: string) => Promise<ConsumableNoteRecord[]>;
  getInputNotes: (filter?: NoteFilter) => Promise<InputNoteRecord[]>;
  getTransactions: (filter?: TransactionFilter) => Promise<TransactionRecord[]>;

  // --- Mutation methods (auto-locked, full pipeline) ---
  /** Execute + prove + submit + apply. Returns after the full pipeline completes. */
  consumeNotes: (accountId: string, noteIds: string[]) => Promise<TransactionResult>;
  newWallet: (options?: CreateWalletOptions) => Promise<Account>;
  newFaucet: (options?: CreateFaucetOptions) => Promise<Account>;
  sendPrivateNote: (note: Note, recipientAddress: string) => Promise<void>;

  // --- Escape hatches ---
  /** Run multiple operations under a single lock (for multi-step sequences) */
  atomic: <T>(fn: (rawClient: WebClient) => Promise<T>) => Promise<T>;
  /** The raw WebClient (caller responsible for locking + fresh IDs) */
  raw: WebClient;
}
```

**Breaking change migration**:
- `useMiden().client.someMethod()` → `useMiden().client.raw.someMethod()` for any method not on `MidenClient`
- `useMiden().runExclusive(fn)` → `useMiden().client.atomic(fn)` (old `runExclusive` still available for backward compat)
- All SDK hooks (`useSend`, `useConsume`, etc.) are updated internally — no consumer changes needed for hook-based code
- Consider shipping a codemod or deprecation warnings for one release cycle before removing `runExclusive`

**Key design**:
- `client` IS the safe wrapper — no separate `safeClient` to discover
- All methods accept string IDs and create fresh `AccountId` objects internally
- `consumeNotes` runs the full execute→prove→submit→apply pipeline (matching what `useConsume` does)
- `client.atomic()` replaces `runExclusive()` for multi-step sequences
- `client.raw` provides the escape hatch for cases where you truly need the underlying `WebClient`

**Arena code eliminated**: `parseId()` helpers, "fresh AccountId" comments, manual `runExclusive` wrapping in useSessionWallet

---

### 7. React StrictMode Compatibility
**Priority**: High
**Solves**: Pain point 7

**Problem** (`MidenProvider.tsx`): The current code has partial StrictMode handling — `cancelled` flag in cleanup + `runExclusive` queuing — but `isInitializedRef` is only set on success and never reset on cleanup. For the non-signer path, the guard `if (!signerContext && isInitializedRef.current) return` prevents re-init on StrictMode remount if mount-1 succeeded before mount-2 ran.

**Current state**: The code already has a comment mentioning StrictMode (line 231-232), but the arena still needed to remove StrictMode, suggesting the handling is incomplete. This needs investigation:
1. If mount-1 succeeds and sets `isInitializedRef = true` before cleanup runs, mount-2 sees the ref as true and skips — creating only one client (correct)
2. If mount-1 is cancelled by cleanup before success, mount-2 runs normally — creating one client (correct)
3. Edge case: if mount-1 succeeds AND creates a client, then cleanup runs but doesn't destroy the client, mount-2 creates a second client — resource leak

**Fix** (internal, no API change):
```typescript
// In MidenProvider's init effect cleanup:
return () => {
  cancelled = true;
  // Reset so mount-2 can re-init if needed. The cancelled flag prevents
  // mount-1 from setting state after cleanup, and runExclusive queuing
  // ensures mount-2 waits for any in-progress WASM init.
  isInitializedRef.current = false;
  // Also reset client to null to prevent stale client reference
  // if mount-1 set it before cleanup ran.
};
```

**Important**: This fix must be verified against the actual init flow to ensure it doesn't cause duplicate `WebClient` creation. If the `runExclusive` queue processes mount-1's init fully before mount-2 starts, resetting the ref is safe. If not, the `cancelled` flag on the first closure prevents it from calling `setClient()`.

**Arena code eliminated**: The "React.StrictMode intentionally omitted" comment and workaround in main.tsx. Apps can use StrictMode normally (required for Next.js).

---

### 8. Consistent Account ID Format
**Priority**: Medium
**Solves**: Pain point 10

**Problem**: `AccountId.toString()` returns hex, wallet adapters return bech32, `NoteSummary.sender` is bech32 but note record IDs are hex. The arena wrote `parseId()` try/catch helpers.

```typescript
// New exported utilities
function normalizeAccountId(id: string): string;  // Always returns bech32
function accountIdsEqual(a: string, b: string): boolean;  // Format-agnostic compare
```

**SDK convention**: All new APIs (`StreamedNote`, `useNoteStream`, `useSessionAccount`) use bech32 as the canonical format. Existing APIs unchanged for backward compatibility.

---

### 9. Enhanced `useNotes` Sender Filter
**Priority**: Medium
**Solves**: Pain point 8 (for apps that don't need full `useNoteStream`)

Additive extension:
```typescript
interface NotesFilter {
  status?: "all" | "consumed" | "committed" | "expected" | "processing";
  accountId?: string;
  // NEW
  sender?: string;
  excludeIds?: string[];
}
```

Client-side filter applied in the `useMemo` that builds `noteSummaries`.

---

### 10. IndexedDB Migration Utilities
**Priority**: Low
**Solves**: Pain point 12

```typescript
interface MigrateStorageOptions {
  version: string;
  versionKey?: string;  // Default: "miden:storageVersion"
  onBeforeClear?: () => void | Promise<void>;
  reloadOnClear?: boolean;  // Default: true
}

async function migrateStorage(options: MigrateStorageOptions): Promise<boolean>;
async function clearMidenStorage(): Promise<void>;
```

**Arena code eliminated**: 53-line `migrateIfNeeded()` in main.tsx

---

### 11. WASM Deduplication Guidance / Built-in Resolution
**Priority**: Medium
**Solves**: Pain point 14

**Problem** (`vite.config.ts:8-19`): When using `file:` dependencies (local SDK development) or any symlinked packages, Vite can bundle two copies of `@miden-sdk/miden-sdk`. WASM class identity checks (`_assertClass`) fail silently — `AccountId` created by one copy is rejected by the other. The arena needed 15 lines of Vite config:
```typescript
resolve: {
  alias: { "@miden-sdk/miden-sdk": path.resolve(__dirname, "node_modules/@miden-sdk/miden-sdk") },
  dedupe: ["@miden-sdk/miden-sdk"],
  preserveSymlinks: true,
},
optimizeDeps: { exclude: ["@miden-sdk/miden-sdk"] },
```

**Proposed solutions** (pick one or both):
1. **Documentation**: Ship a `vite.config.ts` template / setup guide with the SDK package. Include Webpack equivalent.
2. **SDK-level fix**: The SDK could detect duplicate instances at runtime (e.g., a global registry check in the WASM init) and throw a clear error: "Multiple copies of @miden-sdk/miden-sdk detected. See https://docs.miden.io/dedup for resolution."
3. **Vite plugin**: Ship a `@miden-sdk/vite-plugin` that auto-configures deduplication, COOP/COEP headers, and the gRPC proxy.

---

### 12. gRPC-web CORS Proxy Guidance
**Priority**: Medium
**Solves**: Pain points 15, 16

**Problem** (`vite.config.ts:33-39`): The WASM client makes gRPC-web requests to `rpc.testnet.miden.io` which don't include CORS headers for `localhost`. The arena proxies through Vite dev server. In production, the arena uses a service worker for COOP/COEP headers (required for `SharedArrayBuffer`).

**Proposed solutions**:
1. **Vite plugin** (same as Proposal 11): Auto-configures the proxy + headers.
2. **Documentation**: Clear guide for Vite, Webpack, and Next.js setups.
3. **SDK-level**: The `rpcUrl: "testnet"` config could internally use a CORS-friendly endpoint, or the SDK could detect the CORS failure and suggest the proxy pattern.
4. **MidenProvider config option**: `config.corsProxy?: string` — if set, the SDK routes gRPC requests through the given proxy URL automatically.

---

### 13. Byte Conversion Utilities
**Priority**: Medium
**Solves**: Pain point 17

**Problem** (`utils/bytes.ts`, 34 lines): The arena needed `bytesToBigInt`, `bigIntToBytes`, and `concatBytes` for the commit-reveal protocol. Any app doing cryptographic operations with note data will need these.

```typescript
// New exports from @miden-sdk/react
function bytesToBigInt(bytes: Uint8Array): bigint;
function bigIntToBytes(value: bigint, length: number): Uint8Array;
function concatBytes(...arrays: Uint8Array[]): Uint8Array;
```

Small addition but prevents every app from writing the same 34 lines.

---

### 14. Wallet Extension Detection with Timeout
**Priority**: Medium
**Solves**: Pain point 18

**Problem** (`useSessionWallet.ts:324-352`): If the MidenFi extension loads slowly, `connect()` fails because the adapter isn't in `Installed` state yet. The arena implements a 20-line polling/timeout pattern listening for `readyStateChange`.

**Proposed change**: The `useWallet()` hook (or a new `useWalletConnect()`) should handle this internally:
```typescript
interface ConnectOptions {
  /** Timeout (ms) to wait for extension detection. Default: 5000 */
  detectionTimeoutMs?: number;
}
```

When `connect()` is called and the adapter isn't ready yet, the hook internally polls for `readyStateChange` with the configured timeout, rather than immediately failing. Returns `isDetecting: boolean` for UI feedback.

---

### 15. Dual-Provider Setup Documentation / Simplification
**Priority**: Medium
**Solves**: Pain point 19

**Problem** (`main.tsx:86-103`): The arena nests `WalletProvider > MidenProvider > App`. The nesting order matters (MidenProvider needs to be inside WalletProvider if using signer context). This is undocumented and confusing.

**Proposed solutions**:
1. **Combined provider**: A `MidenAppProvider` that wraps both, with configuration:
   ```typescript
   <MidenAppProvider
     wallets={[new MidenWalletAdapter({ appName: "My App" })]}
     network="testnet"
     config={{ rpcUrl: "testnet", autoSyncInterval: 2000 }}
   >
     <App />
   </MidenAppProvider>
   ```
2. **At minimum**: Documentation with example showing correct nesting order and explaining why.

---

### 16. `useNotes` Smart Refetching
**Priority**: Low
**Solves**: Pain point 20

**Problem**: `useNotes` refetches after every sync (line 118-121 of `useNotes.ts`), even when the sync returned no new notes. In a game with 2-second sync intervals, this causes unnecessary re-renders and UI flickers.

**Proposed fix**: Compare the new notes array with the previous one by ID before updating the store. If the set of note IDs hasn't changed, skip the store update (prevents downstream re-renders).

```typescript
// In MidenStore.ts or useNotes.ts
const prevIds = new Set(prevNotes.map(n => n.id().toString()));
const newIds = new Set(fetchedNotes.map(n => n.id().toString()));
if (setsEqual(prevIds, newIds)) return; // Skip update
```

---

### 17. `useSend` with `sendAll` / Balance Query
**Priority**: Low
**Solves**: Pain point 25

**Problem** (`useStaking.ts:152-161`): The arena manually calculates withdrawal amounts. A common pattern is "send everything back to the main wallet." The SDK has `useAccount().getBalance()` but no way to say "send my full balance of asset X."

```typescript
// sendAll and amount are mutually exclusive.
// If both are provided, sendAll takes precedence (amount is ignored).
// If neither is provided, throw an error.
interface SendOptions {
  // ... existing fields
  /** Send the full balance of this asset. When true, `amount` is ignored. */
  sendAll?: boolean;
}
```

When `sendAll: true`, the hook internally queries the account's balance for the given `assetId` and uses that as the amount. Throws if the balance is zero.

---

### 18. Session State Persistence Helpers
**Priority**: Low
**Solves**: Pain point 21

**Problem** (`utils/persistence.ts`, 106 lines): The arena wrote extensive localStorage helpers for session wallet ID, opponent ID, role, draft state, etc. Any dApp with multi-screen flows needs similar persistence.

**Proposed change**: The `useSessionAccount` hook (Proposal 4) handles its own persistence. For general app state, provide a utility:

```typescript
// Light key-value persistence with app-namespaced keys
function createMidenStorage(prefix: string): {
  get: <T>(key: string) => T | null;
  set: <T>(key: string, value: T) => void;
  remove: (key: string) => void;
  clear: () => void;  // Clears only keys under this prefix
};
```

This is low priority because Zustand persist middleware or similar can handle this, but it's nice to have for consistency.

---

### 19. `useTransaction` Stage Consistency
**Priority**: Low
**Solves**: Pain point 24

**Problem**: `useSend` reports observable stages `executing → proving → submitting → complete`. `useTransaction` sets `executing` (line 83) then immediately sets `proving` (line 87) with no async work between — React batches both setState calls, so `executing` is never rendered. Additionally, `useTransaction` has no `submitting` stage. Neither does `useConsume` (goes `executing → proving → complete`).

**Fix**: Ensure all transaction hooks report the same observable stage progression:
```typescript
// useTransaction.ts:
setStage("executing");
const accountIdObj = resolveAccountId(options.accountId);
const txRequest = await resolveRequest(options.request, client);  // <-- async boundary makes "executing" observable
setStage("proving");
// ... prove + submit
setStage("submitting");  // if using separate prove/submit path
setStage("complete");
```

For `submitNewTransaction` / `submitNewTransactionWithProver` which combine prove+submit, use `proving` for the combined phase (since there's no separate submit step). The key fix is the async boundary before `proving`.

---

### 20. Concurrent Send Protection in SDK
**Priority**: Low
**Solves**: Pain point 23

**Problem**: If two sends fire concurrently from the same account, the second transaction builds on stale state (because the first hasn't been applied yet). This causes a "state commitment mismatch" error. The arena has a protocol test specifically demonstrating this (`protocol.test.ts:1145`).

**The auto-sync + concurrency guard in Proposal 3 partially addresses this.** Additionally:
- `useSend` should queue concurrent calls rather than running them in parallel
- Or at minimum, throw a clear error: "A transaction is already in progress for this account. Await the previous send before starting another."

The `isBusy` ref from Proposal 3 prevents the most common case (double-click). For intentional concurrent sends (rare), a queue would be ideal.

---

### 21. WASM Error Wrapping
**Priority**: Medium
**Solves**: Pain point 26

**Problem**: WASM errors surface as cryptic messages: `_assertClass` failures when passing an `AccountId` from one WASM module copy to another, silent `null` returns when accessing consumed pointers, `RuntimeError: unreachable` for internal panics. These errors give no hint about what went wrong or how to fix it.

**Proposed change**: Wrap all `client` method calls (in the safe `MidenClient` from Proposal 6) with try/catch that intercepts common WASM error patterns and rethrows with actionable messages:

```typescript
// Error wrapping examples:
try {
  return await rawClient.someMethod(accountId);
} catch (e) {
  const msg = String(e);
  if (msg.includes("_assertClass")) {
    throw new MidenError(
      "WASM class identity mismatch. This usually means multiple copies of @miden-sdk/miden-sdk " +
      "are bundled. See: https://docs.miden.io/troubleshooting/dedup",
      { cause: e }
    );
  }
  if (msg.includes("null pointer") || msg.includes("already been freed")) {
    throw new MidenError(
      "WASM object was already consumed. AccountId and other WASM objects can only be used once. " +
      "Create a fresh object for each call using parseAccountId() or AccountId.fromBech32().",
      { cause: e }
    );
  }
  throw e;
}
```

**Implementation**:
- New `MidenError` class extending `Error` with `code` field for programmatic handling
- Error pattern registry: map of regex → human-readable message + suggested fix
- Applied automatically in the `MidenClient` wrapper (Proposal 6) — no consumer effort required
- Also useful standalone for apps using `client.raw` or `client.atomic()` — export a `wrapWasmError(e: unknown): Error` utility

**Error codes** (examples):
- `WASM_CLASS_MISMATCH` — duplicate SDK copies
- `WASM_POINTER_CONSUMED` — reused WASM object
- `WASM_NOT_INITIALIZED` — called before init
- `WASM_SYNC_REQUIRED` — stale state (detected heuristically)

---

### 22. `useMultiSend` Parity with `useSend`
**Priority**: Low
**Solves**: Pain point 27

**Problem**: The SDK exports `useMultiSend` for sending to multiple recipients in a single transaction. If `useSend` gains attachment support (Proposal 2), auto-sync (Proposal 3), and concurrency guards (Proposal 3), `useMultiSend` should get the same treatment — otherwise developers face an inconsistent API where some features work on one hook but not the other.

**Proposed change**: Extend `MultiSendOptions` with the same additions:
```typescript
interface MultiSendRecipient {
  to: string;
  assetId: string;
  amount: bigint;
  noteType?: "private" | "public" | "encrypted";
  attachment?: bigint[] | Uint8Array | number[];  // NEW — per-recipient attachment
}

interface MultiSendOptions {
  from: string;
  recipients: MultiSendRecipient[];
  skipSync?: boolean;  // NEW
}
```

**Implementation**: Mirror `useSend` changes — auto-sync before send, `isBusy` ref, attachment construction per recipient. Internal to `useMultiSend.ts`.

---

## Impact Summary

| # | Proposal | Priority | Arena Code Impact | Bugs/Issues Prevented |
|---|----------|----------|-------------------|----------------------|
| 1 | useNoteStream | Critical | ~250 lines eliminated (decoder + stale tracking x3) | Format mismatches |
| 2 | Attachment in useSend | Critical | ~30 lines/send + 12 WASM imports eliminated | Pointer leaks |
| 3 | Auto-sync + concurrency | High | ~16 lines (6 syncs + isSendingRef) | Race conditions, double-sends |
| 4 | useSessionAccount | High | ~340 lines (378 → ~40) | Setup state bugs |
| 5 | Attachment utilities | High | ~20 lines (readAttachment helper) | — |
| 6 | Safe client by default | High | ~30 lines (parseId + runExclusive) | WASM corruption |
| 7 | StrictMode fix | High | Removes StrictMode restriction | Init failure in Next.js |
| 8 | ID normalization | Medium | ~10 lines (parseId helpers) | Format bugs |
| 9 | Sender filter in useNotes | Medium | ~20 lines/hook | — |
| 10 | Migration utils | Medium | ~53 lines (migrateIfNeeded) | Stale IndexedDB state |
| 11 | WASM dedup guidance/plugin | Medium | ~15 lines Vite config | Silent class identity failures |
| 12 | gRPC CORS proxy guidance | Medium | ~7 lines Vite config | CORS failures, COOP/COEP errors |
| 13 | Byte conversion utilities | Medium | ~34 lines (bytes.ts) | — |
| 14 | Wallet extension detection | Medium | ~20 lines polling/timeout | Connection failures on slow load |
| 15 | Dual-provider simplification | Medium | Reduces setup confusion | Incorrect nesting order |
| 16 | Smart refetching in useNotes | Low | Fewer re-renders | UI flicker on 2s sync |
| 17 | sendAll option in useSend | Low | ~15 lines withdrawal logic | — |
| 18 | Session persistence helpers | Low | ~106 lines (persistence.ts) | — |
| 19 | Transaction stage consistency | Low | Clearer stage reporting | — |
| 20 | Concurrent send protection | Low | Prevents state mismatch | State commitment errors |
| 21 | WASM error wrapping | Medium | Better DX for all WASM errors | Cryptic error messages |
| 22 | useMultiSend parity | Low | Consistent API across send hooks | Feature inconsistency |
| | **Total** | | **~1000+ lines** | **10 bug/DX classes** |

---

## LLM-Friendliness Design Principles

These proposals follow principles that make APIs easy for LLMs to use correctly:

1. **One obvious way**: `useSend({ attachment })` instead of choosing between `useSend` / `useTransaction` + manual WASM
2. **Safe by default**: `client` auto-locks and creates fresh WASM objects; auto-sync handles freshness; concurrency guard prevents double-sends
3. **String IDs everywhere**: No WASM `AccountId` objects in public APIs — strings in, strings out
4. **No hidden state requirements**: No "remember to call sync() before send()" or "create fresh AccountId each time"
5. **Consistent formats**: Bech32 everywhere in new APIs; `normalizeAccountId()` for interop
6. **Pre-decoded data**: `StreamedNote.attachment` is already `bigint[]`, not a WASM chain to navigate
7. **Declarative filtering**: `useNoteStream({ sender, since, amountFilter })` instead of imperative ref-based filtering

---

## Verification

For each proposal, verify by:
1. Reimplementing the corresponding arena hook using only the new SDK API
2. Confirming the arena hook shrinks to <30 lines (or is eliminated)
3. Running `npx tsc --noEmit` on the arena after migration
4. Playing a full game (matchmake → draft → battle → game over) to verify P2P note flow works

---

## Files to Modify in React SDK

### New files
| File | Proposals |
|------|-----------|
| `src/hooks/useNoteStream.ts` | 1 — Temporal note tracking with unified model |
| `src/hooks/useSessionAccount.ts` | 4 — Session wallet lifecycle |
| `src/utils/noteAttachment.ts` | 5 — `readNoteAttachment`, `createNoteAttachment` |
| `src/utils/accountId.ts` | 8 — `normalizeAccountId`, `accountIdsEqual` (builds on existing `accountParsing.ts` + `accountBech32.ts`) |
| `src/utils/bytes.ts` | 13 — `bytesToBigInt`, `bigIntToBytes`, `concatBytes` |
| `src/utils/storage.ts` | 10, 18 — `migrateStorage`, `clearMidenStorage`, `createMidenStorage` |
| `src/utils/errors.ts` | 21 — `MidenError` class, `wrapWasmError`, error pattern registry |
| `src/client/MidenClient.ts` | 6, 21 — Safe client wrapper with auto-locking + error wrapping |

### Modified files
| File | Proposals |
|------|-----------|
| `src/hooks/useNotes.ts` | 9 (sender filter), 16 (smart refetch) |
| `src/hooks/useSend.ts` | 2 (attachment), 3 (auto-sync + concurrency), 17 (sendAll), 20 (queue) |
| `src/hooks/useMultiSend.ts` | 22 (attachment, auto-sync, concurrency parity with useSend) |
| `src/hooks/useTransaction.ts` | 3 (auto-sync + concurrency), 19 (stage consistency) |
| `src/context/MidenProvider.tsx` | 6 (safe client wrapper), 7 (StrictMode fix) |
| `src/store/MidenStore.ts` | 1 (`noteFirstSeen` map), 16 (smart diff before store update) |
| `src/index.ts` | All — export new hooks, types, utilities |
| `src/types/index.ts` | All — `StreamedNote`, `MidenClient`, `UseNoteStreamOptions`, etc. |

### Documentation / tooling (new)
| File | Proposals |
|------|-----------|
| `docs/setup-guide.md` or README | 11 (Vite dedup), 12 (CORS proxy), 15 (provider nesting) |
| `packages/vite-plugin/` (optional) | 11, 12 — auto-configure dedup, CORS, COOP/COEP headers |

### Wallet adapter changes
| File | Proposals |
|------|-----------|
| `useWallet()` or `useWalletConnect()` | 14 — built-in extension detection timeout |
| Combined provider component | 15 — `MidenAppProvider` wrapping both providers |
