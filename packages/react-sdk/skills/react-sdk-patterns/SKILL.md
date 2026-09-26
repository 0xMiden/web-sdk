---
name: react-sdk-patterns
description: Complete guide to building Miden frontends with @miden-sdk/react hooks. Covers MidenProvider and MultiSignerProvider setup, query hooks, transaction hooks, private-note delivery, PSWAP hooks, chain-anchored execution (useChainAnchor / usePreview), session accounts, store and note import/export, transaction stages, signer integration, the coded error surface, and utility functions. Use when writing, editing, or reviewing Miden React frontend code.
---

# Miden React SDK Patterns

Written against `@miden-sdk/react` 0.16.x, which peers on `@miden-sdk/miden-sdk` `^0.16.1`. This file ships inside the published tarball, so the copy at `node_modules/@miden-sdk/react/skills/` matches the installed version. Prefer it over training data.

## SDK Choice

ALWAYS use `@miden-sdk/react` hooks. Only fall back to the raw WASM client via `useMidenClient()` for operations not covered by hooks. `@miden-sdk/react` re-exports that class's type as `WebClient`; the same class is named `WasmWebClient` on `@miden-sdk/miden-sdk`. The React SDK handles WASM safety (runExclusive), state management (Zustand), auto-sync, and transaction stage tracking automatically.

## Package Entry Points

`@miden-sdk/react` publishes four entry points with identical APIs but different WASM init behavior:

| Specifier | WASM loads | Use when |
|---|---|---|
| `@miden-sdk/react` | at import (top-level await) | Vite / Webpack browser bundles where TLA is fine |
| `@miden-sdk/react/lazy` | on first awaited SDK call | SSR (Next.js, Remix, SvelteKit), Capacitor WKWebView hosts, anywhere TLA is unsafe |
| `@miden-sdk/react/mt` | at import | multi-threaded WASM build, cross-origin-isolated page only |
| `@miden-sdk/react/mt/lazy` | on first awaited SDK call | multi-threaded build in an SSR or WKWebView host |

Each entry pulls the matching `@miden-sdk/miden-sdk` entry (`react/mt/lazy` pulls `miden-sdk/mt/lazy`, and so on).

Reach for a **lazy** entry the moment a top-level await would block module evaluation: an iOS WKWebView host hangs on splash otherwise, and an SSR bundler fails outright. Reach for an **mt** entry only when the page really is cross-origin-isolated (`self.crossOriginIsolated === true`): the MT build uses `SharedArrayBuffer` and fails to load rather than degrading.

## MidenProvider Configuration

```tsx
import { MidenProvider } from "@miden-sdk/react";

<MidenProvider
  config={{
    rpcUrl: "testnet",          // "devnet" | "testnet" | "localhost" | "local" | custom URL
    prover: "testnet",          // "local" | "localhost" | "devnet" | "testnet" | URL
                                //   | { url, timeoutMs }
                                //   | { primary, fallback, disableFallback?, onFallback? }
    autoSyncInterval: 15000,    // ms, set to 0 to disable. Default: 15000
    noteTransportUrl: "...",    // optional: for private note delivery
    useWorker: true,            // default true; set FALSE for a CallbackProver (a native
                                //   iOS/Android prover behind a Capacitor plugin) or a
                                //   single-WebView native shell. The worker boundary
                                //   serializes the prover and silently downgrades a
                                //   callback prover to "local", so your callback never fires.
    proverTimeoutMs: 10000,     // optional: remote-prover request timeout
    proverUrls: { testnet: "...", devnet: "..." },  // optional: override network prover URLs
    seed: seedBytes,            // optional: 32-byte Uint8Array for a deterministic RNG
  }}
  loadingComponent={<Loading />}  // shown during WASM init
  errorComponent={(error) => <Error error={error} />}  // function form receives the Error; a static element does not
>
  <App />
</MidenProvider>
```

| Network | rpcUrl | Use When |
|---------|--------|----------|
| Testnet | `"testnet"` | Recommended for new projects - primary development network |
| Devnet | `"devnet"` | Early-access testing (may lag feature parity with testnet) |
| Localhost | `"localhost"` | Local node at `http://localhost:57291` |

`MidenConfig` has no `observer` / `observeSensitive` field. Those are `ClientOptions` on the standalone `MidenClient` from `@miden-sdk/miden-sdk`; passing them to `MidenProvider` does nothing. Do not invent them here.

There is also **no `storeName` config field**. `storeName` lives on `SignerContextValue`, and when a signer is connected `MidenProvider` derives the IndexedDB name from it as `` `MidenClientDB_${signer.storeName}` ``. That is why `SignerContextValue.storeName` must be unique per user - it is the database isolation boundary.

## Hook Inventory

The package exports 37 hooks from `src/hooks/`, plus the context accessors `useMiden`, `useMidenClient`, `useSigner` and `useMultiSigner`. The ones documented in detail below are the common path; these exist too and follow the same conventions:

| Hook | Kind | Notes |
|------|------|-------|
| `useBridge()` | transaction | AggLayer bridge-out. `bridge({ from, bridgeAccount, assetId, amount, destinationNetwork, destinationAddress, skipSync? })` |
| `useCreateNetworkNote()` | transaction | see "Network Notes" below |
| `usePswapCreate/Consume/Cancel/CancelByOrder()` | transaction | see "PSWAP" below |
| `usePswapLineages/LineagesFor/Lineage()` | query | tracked PSWAP lineages |
| `useChainAnchor()` / `usePreview()` | see "Chain-Anchored Execution" | expose `isCapturing` / `isPreviewing`, not `isLoading` |
| `useCompile()` | compile | `{ component, txScript, noteScript, isReady }` |
| `useExecuteProgram()` | read-only view call | the action is named **`execute`**, not `executeProgram`: `execute({ accountId, script, adviceInputs?, foreignAccounts?, skipSync? })` returns `{ stack: bigint[] }` |
| `useSyncControl()` | control | `{ pauseSync, resumeSync, isPaused }`. Use this instead of `autoSyncInterval: 0` when you need to stop auto-sync after mount; manual `useSyncState().sync()` still works while paused |
| `useExportStore()` / `useImportStore()` | store portability | `isExporting` / `isImporting` |
| `useExportNote()` / `useImportNote()` | note portability | `exportNote(noteId)` returns `Uint8Array`; `importNote(bytes)` returns the note id |
| `MultiSignerProvider` / `SignerSlot` / `useMultiSigner` | signer | see "Signer Integration" |

## Query Hooks

Each returns its own result shape plus `isLoading` and `error`. **`refetch` is not
universal**: `useNoteStream` has none, `useSyncState` exposes `sync` instead, and
`useAccounts` hardcodes `error: null` and so never reports a fetch failure. Read the
hook's own `Use*Result` interface before destructuring.

### useAccounts()
```tsx
const { accounts, wallets, faucets, isLoading, error, refetch } = useAccounts();
// accounts - AccountHeader[] (every tracked account)
// wallets  - mirrors `accounts` (faucet-vs-wallet is not encoded in the account id)
// faucets  - always `[]`
```

An account's faucet-vs-wallet kind is not encoded in the account id, so `wallets` mirrors `accounts` and `faucets` is always empty. Use `accounts` and detect faucets **per-account** via `account.isFaucet()` (load the full `Account` with `useAccount`).

`useAccounts().error` is always `null`. The hook swallows fetch failures and leaves `accounts` at its last value, so do not gate UI on it. For provider-init failures read `useMiden().error` instead.

### useAccount(accountId: AccountRef | undefined)
```tsx
const { account, assets, getBalance, isLoading, error, refetch } = useAccount(accountId);
// account - Account object (.id(), .nonce(), .bech32id(), .isFaucet())
// assets - AssetBalance[] (assetId, amount, symbol?, decimals?)
// getBalance(faucetId) - bigint balance for specific token
```

`account.id()` and `account.nonce()` are methods (call them, then `.toString()` to render). `bech32id()` is installed on the `Account` prototype by the React SDK.

`AccountRef` is `string | AccountId | Account | AccountHeader` - hex, bech32, or a live object, interchangeably. Most hook options take `AccountRef` (`SendOptions.from/to/assetId`, `MintOptions`, `SwapOptions`, `WaitForNotesOptions.accountId`, `NotesFilter.accountId`). `ConsumeOptions.accountId` is the exception and is typed plain `string`.

### useNotes(filter?)
```tsx
const { notes, consumableNotes, noteSummaries, consumableNoteSummaries, isLoading, error, refetch } = useNotes();
// notes - InputNoteRecord[] (filtered ONLY by `status`)
// consumableNotes - ConsumableNoteRecord[] (filtered ONLY by `accountId`)
// noteSummaries - NoteSummary[] (id, assets, sender) - also filtered by `sender` and `excludeIds`
// consumableNoteSummaries - NoteSummary[] - also filtered by `sender` and `excludeIds`

// Each filter option only narrows specific fields - destructure the one it affects:

// `status` filters the returned `notes` (the only option that does):
const { notes } = useNotes({ status: "committed" });  // "all" | "consumed" | "committed" | "expected" | "processing"
// `accountId` filters `consumableNotes` (NOT `notes`):
const { consumableNotes } = useNotes({ accountId: "0x..." });
// `sender` filters only the summary arrays (NOT `notes`/`consumableNotes`):
const { noteSummaries, consumableNoteSummaries } = useNotes({ sender: "0x..." });
// `excludeIds` filters only the summary arrays:
const { noteSummaries, consumableNoteSummaries } = useNotes({ excludeIds: ["0xnote1", "0xnote2"] });
```

### useNoteStream(options?)
```tsx
const { notes, latest, markHandled, markAllHandled, snapshot, isLoading, error } = useNoteStream();
// notes - StreamedNote[] (matching filter criteria)
// latest - most recent StreamedNote (convenience)
// markHandled(noteId) - exclude a note from future renders
// markAllHandled() - exclude all current notes
// snapshot() - capture { ids, timestamp } for cross-phase filtering

// Options:
const { notes } = useNoteStream({ status: "committed", sender: "0x..." });
const { notes } = useNoteStream({ since: Date.now() - 60000 }); // last 60s
const { notes } = useNoteStream({ excludeIds: new Set(["0xnote1"]) });
const { notes } = useNoteStream({ amountFilter: (amount) => amount > 100n });
```

### useSyncState()
```tsx
const { syncHeight, isSyncing, lastSyncTime, sync, error } = useSyncState();
await sync(); // Manual sync
```

### useAssetMetadata(assetIds?: string[])
```tsx
const { assetMetadata } = useAssetMetadata([faucetId]); // takes a string[] (NOT a bare string)
// assetMetadata - Map<string, AssetMetadata>
// Each entry: { assetId, symbol?, decimals? }
const meta = assetMetadata.get(faucetId);
// meta.symbol - "TEST"
// meta.decimals - 8
```

Pass an array even for a single asset - the hook calls `.filter` on its argument, so a bare string throws a runtime `TypeError`.

### useTransactionHistory(options?)
```tsx
const { records, record, status, isLoading, error, refetch } = useTransactionHistory({ id: txId });
// status: "pending" | "committed" | "discarded" | null
// Options: { id?, ids?, filter?, refreshOnSync? }
//   id      - string | TransactionId. Populates `record` and `status`.
//   ids     - Array<string | TransactionId>. `record` and `status` are populated only
//             when exactly one id was supplied; with several they stay null.
//   filter  - a raw TransactionFilter. It OVERRIDES id/ids entirely: when `filter`
//             is set the hook queries with it and applies no local id narrowing.
//   refreshOnSync - re-fetch after every provider sync. Default: true
//                   (only `refreshOnSync: false` turns it off).
```

A note on `ids`: the hook uses `TransactionFilter.ids(...)` only when every entry is a real `TransactionId`. A list containing any hex string falls back to `TransactionFilter.all()` plus a local hex comparison, so it fetches everything and filters in JS.

## Mutation Hooks

Each returns its own action function plus `error` and `reset`. The families differ in their loading/progress fields:
- **Transaction hooks** (`useSend`, `useMultiSend`, `useMint`, `useConsume`, `useSwap`, `useBridge`, `useCreateNetworkNote`, `usePswapCreate`, `usePswapConsume`, `usePswapCancel`, `usePswapCancelByOrder`, `useTransaction`) expose `isLoading` and `stage` (a `TransactionStage`).
- **Account create/import hooks** (`useCreateWallet`, `useCreateFaucet`, `useImportAccount`) expose `isCreating` (or `isImporting` for the latter) and have **no** `stage`.
- **Everything else names its own busy flag**: `useChainAnchor().isCapturing`, `usePreview().isPreviewing`, `useExportStore()` / `useExportNote().isExporting`, `useImportStore()` / `useImportNote().isImporting`.

**Transaction stages**: `"idle"` -> `"executing"` -> `"proving"` -> `"submitting"` -> `"complete"`

Auth scheme for the create/import hooks. At runtime the `AuthScheme` re-exported from the package root is the friendly string const `{ Falcon: "falcon", ECDSA: "ecdsa" }`, because `@miden-sdk/miden-sdk`'s own `AuthScheme` export shadows the numeric wasm enum of the same name:

```tsx
import { AuthScheme } from "@miden-sdk/react";
// AuthScheme.Falcon === "falcon"   |   AuthScheme.ECDSA === "ecdsa"
// AuthScheme.AuthRpoFalcon512 === undefined   <- the trap below
```

> **Known issue, still OPEN in 0.16 ([web-sdk#223](https://github.com/0xMiden/web-sdk/issues/223)):** `useCreateWallet`, `useCreateFaucet`, `useImportAccount` and `useSessionAccount` forward `authScheme` straight to the low-level wasm calls (`newWallet`, `newFaucet`, `importPublicAccountFromSeed`), which expect the **numeric** wasm enum (`AuthRpoFalcon512 = 2`, `AuthEcdsaK256Keccak = 1`), not the friendly string. The hooks' own default is `AuthScheme.AuthRpoFalcon512`, which resolves to `undefined` for the reason above, and wasm-bindgen's `invalid enum value passed` throws inside a worker closure so the promise **never settles** - the call hangs rather than rejecting. Until it is fixed, always pass the numeric value explicitly: `authScheme: 2` (Falcon) or `authScheme: 1` (ECDSA). The examples below use `2`.

### useCreateWallet()
```tsx
const { createWallet, wallet, isCreating, error, reset } = useCreateWallet();
const account = await createWallet({
  storageMode: "private",                   // "private" | "public". Default: "private"
  authScheme: 2,                            // 2 = Falcon; friendly AuthScheme.* not accepted here yet (web-sdk#223)
  initSeed: seedBytes,                       // optional: Uint8Array for a deterministic account id
});
```

### useCreateFaucet()
```tsx
const { createFaucet, faucet, isCreating, error, reset } = useCreateFaucet();
const account = await createFaucet({
  tokenSymbol: "TEST",
  tokenName: "Test Token",                  // optional: defaults to tokenSymbol
  decimals: 8,                              // Default: 8
  maxSupply: 1000000n,                      // bigint | number
  storageMode: "private",                   // "private" | "public". Default: "private"
  authScheme: 2,                            // 2 = Falcon; friendly AuthScheme.* not accepted here yet (web-sdk#223)
});
```

### useImportAccount()
```tsx
const { importAccount, account, isImporting, error, reset } = useImportAccount();

// Import by account ID (network lookup):
const account = await importAccount({ type: "id", accountId: "0x..." });

// Import from file:
const account = await importAccount({ type: "file", file: accountFileOrBytes });

// Import from seed:
const account = await importAccount({
  type: "seed",
  seed: seedBytes,
  authScheme: 2,                            // optional; 2 = Falcon (web-sdk#223 - friendly AuthScheme.* not accepted here yet)
});
```

This hook calls `assertSignerConnected()` before doing anything else. With a signer provider mounted but **disconnected** it throws `"Signer is disconnected. Reconnect your wallet to perform transactions."` It is a no-op in local-keystore mode (`signerConnected === null`) and when the signer is connected. `useImportAccount` and `useMultiSend` are the **only two** hooks that make this check - do not assume the other mutation hooks guard it for you.

### useSend()
```tsx
const { send, result, isLoading, stage, error, reset } = useSend();
await send({
  from: senderAccountId,
  to: recipientAccountId,
  assetId: faucetId,       // token faucet ID
  amount: 1000n,           // bigint!
  noteType: "private",     // "private" | "public". Default: "private"
  recallHeight: 100,       // optional: sender can reclaim after this block
  timelockHeight: 50,      // optional: recipient can consume after this block
  sendAll: true,           // optional: send entire balance (ignores amount)
  attachment: [1n, 2n],    // optional: arbitrary data attached to the note
  returnNote: true,        // optional: populate result.note with the built Note, e.g. for
                           //   out-of-band delivery. WITHOUT it, result.note is null.
  skipSync: true,          // optional: skip the auto-sync before sending
});
```

`amount` is optional in the type (it is ignored when `sendAll: true`) and accepts `bigint | number`, but pass `bigint` - a `number` silently loses precision above `Number.MAX_SAFE_INTEGER`.

**Combining `attachment` with `recallHeight` or `timelockHeight` throws**, before anything is built: `"recallHeight and timelockHeight are not supported when attachment is provided"`. The attachment path constructs the P2ID note by hand and has nowhere to put either height. Pick one or the other.

**Private notes need an explicit delivery push, and the hook does it for you.** For `noteType: "private"` `useSend` waits for the transaction to commit and then calls `client.sendPrivateOutputNote(noteId, recipientAddress)` to hand the note details to the recipient over the note-transport layer. The same push happens in `useMultiSend` (once per private recipient, after one shared commit wait) and in `useTransaction` when `privateNoteTarget` is set. Without it a private note is **never delivered** - the recipient has no way to learn it exists. A public note needs no such push. If you hand-roll a private send through `useTransaction`, either pass `privateNoteTarget` or make the `sendPrivateOutputNote` call yourself.

### useMultiSend()
```tsx
const { sendMany, result, isLoading, stage, error, reset } = useMultiSend();
await sendMany({
  from: senderAccountId,
  assetId: faucetId,
  recipients: [
    { to: recipient1, amount: 500n },
    { to: recipient2, amount: 300n, noteType: "public" },          // per-recipient override
    { to: recipient3, amount: 200n, attachment: [1n, 2n, 3n] },    // per-recipient attachment
  ],
  noteType: "private",     // default for all recipients
  skipSync: false,         // optional
});
```

Resolves to `{ transactionId }`, not `{ txId, note }`. Like `useImportAccount`, it calls `assertSignerConnected()` first and throws on a mounted-but-disconnected signer.

### useMint()
```tsx
const { mint, result, isLoading, stage, error, reset } = useMint();
await mint({
  targetAccountId: recipientId,
  faucetId: myFaucetId,
  amount: 10000n,         // bigint!
  noteType: "public",
});
```

### useConsume()
```tsx
const { consume, result, isLoading, stage, error, reset } = useConsume();
await consume({
  accountId: myAccountId,
  notes: [noteId1, noteId2],   // accepts: hex string IDs, NoteId, InputNoteRecord, or Note
});
```

### useSwap()
```tsx
const { swap, result, isLoading, stage, error, reset } = useSwap();
await swap({
  accountId: myAccountId,
  offeredFaucetId: tokenA,
  offeredAmount: 100n,
  requestedFaucetId: tokenB,
  requestedAmount: 50n,
  noteType: "private",
  paybackNoteType: "private",
});
```

### useTransaction() - Escape Hatch
```tsx
const { execute, result, isLoading, stage, error, reset } = useTransaction();

// With pre-built TransactionRequest:
await execute({ accountId, request: txRequest });

// With factory function (gets access to the raw WASM client).
// Every new*TransactionRequest constructor is async as of 0.16, so the factory
// returns a Promise; `request` accepts `TransactionRequest | Promise<TransactionRequest>`.
await execute({
  accountId,
  request: (client) => client.newSwapTransactionRequest(/* ... */),
});

// Other options:
await execute({
  accountId,
  request: txRequest,
  skipSync: true,             // optional: skip the auto-sync before executing
  privateNoteTarget: "0x...", // optional: deliver private output notes to this account
                              //   after the transaction commits
  anchor,                     // optional: execute against a pinned reference block;
                              //   not for a multisig proposal, which runs at the tip
                              //   (see "Chain-Anchored Execution")
});
```

> **The fee note is an output note (0.16, BREAKING, fails silently).** On any chain whose verification base fee is non-zero, `outputNotes()` returns one more note than it used to, on `ExecutedTransaction`, `TransactionRecord` and `TransactionSummary` alike. Nothing throws; the list is just one longer, so `outputNotes()[0]` may be the fee note rather than the note you created. `ExecutedTransaction` has the fix built in: `userOutputNotes()` is the list without the fee note, `feeNote()` is the fee note alone. `TransactionRecord` and `TransactionSummary` have **no** split accessor - filter or account for the extra note yourself.

### useWaitForCommit()
```tsx
const { waitForCommit } = useWaitForCommit();
await waitForCommit(result.txId, {  // useSend returns { txId, note }; other hooks use { transactionId }
  timeoutMs: 10000,   // Default: 10000
  intervalMs: 1000,    // Default: 1000
});
```

### useWaitForNotes()
```tsx
const { waitForConsumableNotes } = useWaitForNotes();
await waitForConsumableNotes({
  accountId: myAccountId,
  minCount: 1,         // Default: 1
  timeoutMs: 10000,
});
```

### useSessionAccount(options)
```tsx
const { initialize, sessionAccountId, isReady, step, error, reset } = useSessionAccount({
  fund: async (sessionId) => {
    // Called after session wallet is created - fund it here
    await send({ from: mainWallet, to: sessionId, assetId: faucetId, amount: 100n });
  },
  assetId: faucetId,              // optional, RESERVED: the hook body never reads it
  walletOptions: {                // optional: session wallet creation options
    storageMode: "public",                    // "private" | "public". Default: "public"
    authScheme: 2,                            // 2 = Falcon (web-sdk#223)
  },
  pollIntervalMs: 3000,           // optional: funding detection interval. Default: 3000
  maxWaitMs: 60000,               // optional: max wait for the funding note. Default: 60000
  storagePrefix: "miden-session", // optional: localStorage key prefix. Default: "miden-session"
});
// Steps: "idle" -> "creating" -> "funding" -> "consuming" -> "ready"
// Call initialize() to start the flow. isReady becomes true when fully funded.
```

Three things that surprise people here:

- **The session wallet defaults to `storageMode: "public"`**, unlike `useCreateWallet`'s `"private"`. If you want a private session wallet, say so explicitly.
- **`assetId` is reserved and never read.** It is typed and documented as "reserved for future filtering of consumable notes"; the hook body does not consult it. Passing it does nothing, and omitting it changes nothing.
- **The hook persists across reloads.** It writes `${storagePrefix}:accountId` and `${storagePrefix}:ready` to `localStorage`, restores both on mount, and `reset()` removes both. So a session survives a refresh, and clearing it means calling `reset()` rather than dropping your own state.

## Chain-Anchored Execution

A summary that binds the reference block commitment only authorizes an execution at that exact block, so a flow that collects such signatures and executes later - single-signature offline co-signing - captures a `ChainAnchor` next to the summary and ships both.

A multisig proposal (0.17+) needs no anchor: its summary binds the block its auth args name. Build it with `client.feeAwareTransactionRequestBuilder(accountId)`, which declares that block with `withBlockNumbers`, ship the request bytes, and let every party preview and execute at its own tip once its client has synced to at least the bound block (the largest of `request.blockNumbers()`). Below that height the call fails with `requested block N is after transaction reference block M` until the client syncs. `usePreview` does not sync first, and `useTransaction` syncs through the provider's `sync()`, which returns early while another sync runs and records failures instead of throwing, so after syncing confirm `await client.getSyncHeight()` is at least that block before previewing or executing. Re-executing an older multisig proposal at an anchor fails once the node prunes that block's account state (50 blocks).

```tsx
const { captureAnchor, anchor, anchoredRequest, isCapturing, error, reset } = useChainAnchor();
const { preview, summary, isPreviewing } = usePreview();
const { execute } = useTransaction();

// 1. Capture the anchor for a concrete request.
const captured = await captureAnchor({ request: txRequest });

// 2. Derive the summary the account is being asked to authorize, at that block.
const s = await preview({ accountId, request: txRequest, anchor: captured });

// 3. Collect signatures, then execute against the SAME request and anchor. Inside this
//    handler that is txRequest; on a later interaction use `anchoredRequest` and `anchor`.
await execute({ accountId, request: txRequest, anchor: captured });
```

**The trap: never re-invoke a request factory once an anchor exists.** A factory resolves to a new object per call, and two draws from the client's RNG make that object differ every time: any builder minting an output note takes a fresh serial number, and on a fee-charging chain the fee conversion info takes a fresh salt, which reaches even a request with no output notes. A second call therefore yields a transaction the anchor does not pin and the co-signers did not approve. Preview and execute against `anchoredRequest`, the exact request the anchor was captured for. Note `anchoredRequest` is state: inside the handler that just captured, it still holds the previous render's value (`null` on a first capture), so use the object you resolved yourself there and `anchoredRequest` on a later interaction.

Other rules the hook enforces or documents:
- `captureAnchor` rejects with one of **three** codes: `"OPERATION_BUSY"` if a capture is already running, `"INVALID_CHAIN_ANCHOR"` if a sync lands mid-capture (retry that one), and `"STALE_CLIENT"` if the provider swapped the client while the capture was in flight - a network or signer change, where recapturing on the new chain is the only correct move, not a retry. `INVALID_CHAIN_ANCHOR` comes from the client, so on Node it prefixes the message instead of appearing as a property; the other two are `MidenError`s from this package and always carry `code`.
- Capturing runs on the main thread and walks the chain in WASM, so it blocks the UI briefly and queues other client calls behind it.
- The caller owns the anchor. Neither `reset()` nor a client swap frees it. An anchor carries a partial blockchain, so call `anchor.free()` when done in a flow that captures repeatedly.
- **`ChainAnchor` is re-exported type-only by `@miden-sdk/react`.** To rebuild one from bytes, import the class itself from `@miden-sdk/miden-sdk`:

```tsx
import { ChainAnchor } from "@miden-sdk/miden-sdk";   // value import, NOT from @miden-sdk/react
const bytes = captured.serialize();                   // ship to co-signers
const rebuilt = ChainAnchor.deserialize(bytes);
```

`usePreview` is the first summary surface in the React SDK: verifying and co-signing a multisig proposal no longer requires dropping to the WASM client. The summary only exists while authorization is pending, i.e. when the account's auth procedure aborts with the unauthorized event (a multisig below its signing threshold). For a multisig request from `feeAwareTransactionRequestBuilder`, preview without an anchor after syncing to its bound block. Pass `anchor` when verifying a summary that binds the reference block, because deriving that summary at the local sync height produces a different one.

## Network Notes

`useCreateNetworkNote()` builds a Public custom-script note carrying a `NetworkAccountTarget` attachment and submits it as an own output note, so a public network account auto-consumes it. Provide exactly one of `recipient` or `script`.

```tsx
const { createNetworkNote, result, isLoading, stage, error, reset } = useCreateNetworkNote();
const { txId, note } = await createNetworkNote({
  accountId: senderId,        // executing sender: creates, funds and submits
  target: networkAccountId,   // the network account the note targets
  script: noteScript,         // custom consumption script; the recipient is built for you
  inputs: [1n, 2n, 3n],       // note storage felts the script reads (used with `script`)
  // recipient: myRecipient,  // ...or pass a pre-built NoteRecipient instead of `script`
  executionHint: hint,        // optional: defaults to `always`
  assetId: faucetId,          // optional: omit for a zero-asset note
  amount: 1000n,
  attachment: [7n],           // optional: extra payload appended after the target
});
```

This hook is the supported path. Reach for the raw classes only for shapes it does not cover.

## PSWAP (Partial Swaps)

A PSWAP note can be filled by multiple consumers, each taking a proportional share and leaving a remainder note.

```tsx
const { pswapCreate } = usePswapCreate();
await pswapCreate({ accountId, offeredFaucetId, offeredAmount: 100n,
                    requestedFaucetId, requestedAmount: 50n,
                    noteType: "private", paybackNoteType: "private" });

const { pswapConsume } = usePswapConsume();
await pswapConsume({ accountId, note, fillAmount: 20n });

const { pswapCancel } = usePswapCancel();
await pswapCancel({ accountId, note });          // creator reclaims the offered asset

const { pswapCancelByOrder } = usePswapCancelByOrder();
await pswapCancelByOrder({ orderId: "12345678901234567890" });

// Queries over locally tracked lineages:
const { lineages } = usePswapLineages();
const { lineages: mine } = usePswapLineagesFor(accountId);
const { lineage } = usePswapLineage(orderId);
```

Two traps:
- **`orderId` is `string | bigint` and deliberately refuses `number`.** A PSWAP order id is `u64`-shaped and routinely exceeds `Number.MAX_SAFE_INTEGER`, which a JS `number` cannot represent without silent precision loss.
- **`noteFillAmount` defaults to `0` and most callers should leave it unset.** It is the amount of the requested asset supplied by other in-flight notes routed into the same transaction, not the amount you are filling. The amount you supply from your own vault is `fillAmount`.

`note` on consume and cancel accepts a hex string id, a `NoteId`, an `InputNoteRecord`, or a `Note`; string and `NoteId` values are looked up from the local store.

## Transaction Progress UI

```tsx
function SendButton({ from, to, assetId, amount }) {
  const { send, stage, isLoading, error } = useSend();

  return (
    <div>
      <button onClick={() => send({ from, to, assetId, amount })} disabled={isLoading}>
        {isLoading ? `${stage}...` : "Send"}
      </button>
      {error && <p>Error: {error.message}</p>}
    </div>
  );
}
```

## Signer Integration

### Local Keystore (Default)
No signer provider needed. Keys are managed in the browser via IndexedDB.

### External Signers
Wrap MidenProvider with a signer provider. Three pre-built options:
- `ParaSignerProvider` from `@miden-sdk/para-react` - EVM wallets
- `TurnkeySignerProvider` from `@miden-sdk/turnkey-react` - passkey auth
- `MidenFiSignerProvider` from `@miden-sdk/miden-wallet-adapter-react` - MidenFi wallet

All three ship from the web-sdk repo as of 0.16 and version in lockstep with `@miden-sdk/react`. The Para and Turnkey packages dropped the redundant `miden-` prefix in 0.16: `@miden-sdk/use-miden-para-react` and `@miden-sdk/miden-turnkey-react` are the pre-0.16 names and no longer resolve. The five `@miden-sdk/miden-wallet-adapter*` names are unchanged. `@miden-sdk/para-react` 0.16.1 peers on Para SDK `^3.18.0`; the 2.x range was dropped.

```tsx
// Example: Para signer wrapping MidenProvider
import { ParaSignerProvider } from "@miden-sdk/para-react";
<ParaSignerProvider apiKey="..." environment="BETA">
  <MidenProvider config={...}><App /></MidenProvider>
</ParaSignerProvider>
```

### MultiSignerProvider - Several Signers At Once
When an app offers a choice of signers, mount each provider around a `SignerSlot` inside one `MultiSignerProvider`, with `MidenProvider` as the last child. `useMultiSigner()` reads and switches the active signer.

```tsx
import { MidenProvider, MultiSignerProvider, SignerSlot } from "@miden-sdk/react";
import { WalletAdapterNetwork } from "@miden-sdk/miden-wallet-adapter-base";

<MultiSignerProvider>
  <ParaSignerProvider apiKey={...} environment="BETA"><SignerSlot /></ParaSignerProvider>
  <TurnkeySignerProvider><SignerSlot /></TurnkeySignerProvider>
  <MidenFiSignerProvider network={WalletAdapterNetwork.Testnet} autoConnect={false}>
    <SignerSlot />
  </MidenFiSignerProvider>
  <MidenProvider config={{ rpcUrl: "testnet", prover: "testnet" }}>
    <App />
  </MidenProvider>
</MultiSignerProvider>
```

`MidenFiSignerProvider`'s `network` prop is the **`WalletAdapterNetwork` enum** from `@miden-sdk/miden-wallet-adapter-base` (`Devnet | Testnet | Localnet`), not a raw string. It is a TypeScript string enum, so `network="testnet"` does not type-check even though the member's value is `"testnet"`.

```tsx
const { signers, activeSigner, connectSigner, disconnectSigner } = useMultiSigner() ?? {};
await connectSigner("Turnkey");   // switches the active signer and calls its connect()
await disconnectSigner();         // reverts to local-keystore mode
```

Two mechanics worth knowing:

- **`useMultiSigner()` returns `null` outside a `MultiSignerProvider`**, not a throw and not an empty object. Guard it (`?? {}` above) or you will read properties of null in a component that can render outside the provider.
- **`SignerSlot` renders nothing.** It returns `null`, reads its nearest ancestor `SignerContext` via `useSigner()`, and registers that value into the `MultiSignerProvider` registry (unregistering on unmount). It is a registration primitive, not a UI element, so its placement matters only for which provider is its ancestor. `MultiSignerProvider` forwards only the *active* signer down to `MidenProvider`, so before a user picks one the app runs in local-keystore mode.

### useSigner() - Unified Interface
Returns `SignerContextValue | null` - `null` in local-keystore mode (no signer provider mounted). Guard before destructuring.
```tsx
const signer = useSigner();
if (!signer) return null; // local keystore mode
const { isConnected, connect, disconnect, name } = signer;
```

### Custom Signer
Implement `SignerContextValue` interface via `SignerContext.Provider`. Requires: `name`, `storeName` (unique per user for DB isolation), `accountConfig`, `signCb`, `isConnected`, `connect`, `disconnect`. Optional: `getKeyCb` and `insertKeyCb`, for an external keystore that also retrieves and persists secret keys. `SignerAccountConfig.accountType` is `@deprecated` and ignored as of protocol 0.15 - omit it. See `frontend-source-guide` skill for source references.

## Error Surface

```tsx
import { MidenError, wrapWasmError } from "@miden-sdk/react";
import type { CodedError, MidenErrorCode, WasmErrorCode } from "@miden-sdk/react";
```

- `MidenErrorCode` is the **closed** union assigned by this package: `"WASM_CLASS_MISMATCH" | "WASM_POINTER_CONSUMED" | "WASM_NOT_INITIALIZED" | "WASM_SYNC_REQUIRED" | "SEND_BUSY" | "OPERATION_BUSY" | "STALE_CLIENT" | "UNKNOWN"`. Every `MidenError` carries one, defaulting to `"UNKNOWN"`.
- `WasmErrorCode` is the union assigned by the Rust client and thrown out of WASM: `"INVALID_CHAIN_ANCHOR" | "TRANSACTION_ALREADY_AUTHORIZED"`. These are not `MidenError`s.
- `CodedError = Error & { readonly code?: MidenErrorCode | WasmErrorCode | (string & {}) }`. The **`(string & {})` arm is open on purpose**: a code from a newer client stays assignable while the known ones keep autocomplete. So `switch` on `code`, but always leave a default branch - the union is not exhaustive of what you can receive.

Branch on `code`, never on message text; the strings are not a stable API. `wrapWasmError(e)` is the helper that turns a raw WASM throw into a `MidenError` by pattern-matching the message, which is how `_assertClass` / `expected instance of` becomes `WASM_CLASS_MISMATCH` and `null pointer` becomes `WASM_POINTER_CONSUMED`.

**On Node, client-assigned codes arrive as a `"CODE: "` prefix on the message rather than as a property**, because the napi bindings cannot attach one. Code that does `err.code === "INVALID_CHAIN_ANCHOR"` works in the browser and silently never matches under Node; check the message prefix as well if you support both.

## Utility Functions

```tsx
import {
  formatAssetAmount, parseAssetAmount,
  getNoteSummary, formatNoteSummary,
  toBech32AccountId, installAccountBech32, ensureAccountBech32,
  normalizeAccountId, accountIdsEqual,
  readNoteAttachment, createNoteAttachment,
  bytesToBigInt, bigIntToBytes, concatBytes,
  waitForWalletDetection,
  migrateStorage, clearMidenStorage, createMidenStorage,
  MidenError, wrapWasmError,
  DEFAULTS,
} from "@miden-sdk/react";

formatAssetAmount(1000000n, 8)       // "0.01"
parseAssetAmount("0.01", 8)           // 1000000n
const summary = getNoteSummary(note); // { id, assets, sender } | null
formatNoteSummary(summary);           // "1.5 TEST from mtst1..."
toBech32AccountId("0x1234...");       // "mtst1..." (testnet HRP; defaults to testnet)
```

`getNoteSummary(note, getAssetMetadata?)` takes a `ConsumableNoteRecord | InputNoteRecord` and returns `NoteSummary | null` - **`null`** when the note's id is missing or anything in the read throws, i.e. for a note whose id or metadata is not ready yet. Guard before formatting.

`formatNoteSummary(summary, formatAsset?)`: with an **empty `assets` array it returns `summary.id` alone** - no asset text and **no sender suffix**, regardless of whether `sender` is set. Otherwise it joins the assets with `" + "` and appends `" from <sender>"` only when a sender is present. Pass `formatAsset` to override the default `"<amount> <symbol-or-assetId>"` rendering.

`DEFAULTS` is a **value** export, not a type: `{ RPC_URL: undefined, AUTO_SYNC_INTERVAL: 15000, STORAGE_MODE: "private", AUTH_SCHEME: AuthScheme.AuthRpoFalcon512, NOTE_TYPE: "private", FAUCET_DECIMALS: 8 }`. Note `AUTH_SCHEME` reads as `undefined` at runtime in a browser build, for the shadowing reason in web-sdk#223 above - which is exactly why the create hooks hang when you omit `authScheme`.

`waitForWalletDetection(adapter, timeoutMs = 5000)` resolves once the adapter's `readyState` reaches `"Installed"` and otherwise rejects with `"Wallet extension not detected within <n>ms."` Its `WalletAdapterLike` argument is a duck type (`{ readyState: string; on/off("readyStateChange", cb) }`) with no dependency on any wallet-adapter package, so it works against any adapter and against a plain fake object.

The HRP is inferred from the configured `rpcUrl` and defaults to testnet: mainnet=`mm`, testnet=`mtst` (default), devnet=`mdev` - there is no `miden` HRP. See `frontend-pitfalls` FP5 for the trap in that inference.

## Direct Client Access

```tsx
const client = useMidenClient(); // throws if not ready
const { runExclusive } = useMiden();

// For operations not covered by hooks (use methods on the WebClient itself -
// e.g. getSyncHeight, getAccount, getTransactions; getBlockHeaderByNumber lives on RpcClient, not here):
await runExclusive(async () => {
  const height = await client.getSyncHeight();
});
```

**The built-in hooks route their own client calls through `runExclusive` too.** 22 files under `src/hooks/` pull it out of `useMiden()` and wrap their multi-call work, using the pattern `const runExclusiveSafe = runExclusive ?? runExclusiveDirect;` so they still serialize when no provider-supplied lock is available: `useSend`, `useMint`, `useConsume`, `useSwap`, `useBridge`, `useTransaction`, `usePreview`, `useChainAnchor`, `useCreateWallet`, `useCreateFaucet`, `useExecuteProgram`, `useCreateNetworkNote`, `useMultiSend`, `useWaitForNotes`, the four export/import hooks and all four PSWAP transaction hooks. Use it for your own multi-step sequences for the same reason they do - the client serializes each individual forwarded call, not your group of them (see `frontend-pitfalls` FP2, which also names the raw-bound `SYNC_METHODS` that serialize themselves not at all).

## Non-Surface: Do Not Invent These

- **No dedicated React fee hook or provider option.** For a custom request, obtain the underlying client and call its `feeAwareTransactionRequestBuilder(accountId)` instance method.
- **No `AccountDelta` / `AccountPatch` re-export.** The only summary-shaped re-export is `TransactionSummary` (used by `usePreview`).
- **No protocol `AssetId` / `AssetClass` / `AssetVaultKey` type.** Every `assetId` in this package is a faucet (token) account reference - `asset.faucetId().toString()`. Do not "fix" these names to protocol ones.
- **No `mutable` wallet option and no `storageMode: "network"`.** `CreateWalletOptions` is exactly `{ storageMode?, authScheme?, initSeed? }`.

> **The package's own `README.md` and `ReactSDK.Arena.Findings.md` are stale - do not treat them as authoritative.** The README still documents `authScheme: 0`, a `mutable: true` wallet option and `storageMode: 'network'`, none of which exist in `src/types/index.ts`. The Arena findings file is a proposal document and describes an API that was never shipped in that shape. `src/types/index.ts` plus the hook bodies are the source of truth, and the package's `AGENTS.md` (which ships alongside this skill) is kept current.

## Type Imports

```tsx
import { AuthScheme, DEFAULTS, MidenError } from "@miden-sdk/react"; // values, not just types
// AuthScheme is the friendly string const { Falcon, ECDSA } at runtime - see web-sdk#223.

import type {
  MidenConfig, RpcUrlConfig, ProverConfig, ProverTarget, ProverUrls,
  QueryResult, MutationResult, TransactionStage, AccountRef,
  AccountsResult, AccountResult, AssetBalance, NotesFilter, NotesResult, NoteSummary,
  SendOptions, SendResult, MultiSendOptions, MultiSendRecipient,
  MintOptions, ConsumeOptions, SwapOptions, BridgeOptions,
  CreateNetworkNoteOptions, NetworkNoteResult,
  PswapCreateOptions, PswapConsumeOptions, PswapCancelOptions,
  PswapCancelByOrderOptions, PswapLineagesResult, PswapLineageResult,
  CreateWalletOptions, CreateFaucetOptions, ImportAccountOptions,
  ExecuteTransactionOptions, CaptureAnchorOptions, PreviewTransactionOptions,
  ExecuteProgramOptions, ExecuteProgramResult,
  TransactionResult, SyncState, WaitForCommitOptions, WaitForNotesOptions,
  TransactionHistoryOptions, TransactionHistoryResult, TransactionStatus,
  StreamedNote, UseNoteStreamOptions, UseNoteStreamReturn,
  UseSessionAccountOptions, UseSessionAccountReturn, SessionAccountStep,
  Account, AccountId, AccountHeader, InputNoteRecord, ConsumableNoteRecord,
  TransactionRecord, TransactionRequest, TransactionSummary, ChainAnchor,
  NoteType, AccountStorageMode, PswapLineageRecord,
  SignerContextValue, SignCallback, SignerAccountConfig,
  MultiSignerContextValue, WalletAdapterLike,
  CodedError, MidenErrorCode, WasmErrorCode,
} from "@miden-sdk/react";
```

Every hook also exports its own result type from the package root, all suffixed `…Result` (`UseSendResult`, `UseCreateWalletResult`, `UseChainAnchorResult`, and so on) - with two exceptions that use `…Return`: `UseNoteStreamReturn` and `UseSessionAccountReturn`.

`TransactionSummary` and `ChainAnchor` are re-exported **as types only**. If you need the runtime class (e.g. `ChainAnchor.deserialize`), import it from `@miden-sdk/miden-sdk`.

## Reading Account Storage

For the high-level vault summary on a tracked account, the existing query hook is enough:

```tsx
const { account, assets, getBalance } = useAccount(accountId);
// account.id(), account.nonce(), account.bech32id()   <- all three are methods
// assets: AssetBalance[]; getBalance(faucetId): bigint
```

For lower-level reads (custom contract storage slots, map items), use `Account.storage()`. The React SDK serializes WASM access via `runExclusive`:

```tsx
const client = useMidenClient();
const { runExclusive } = useMiden();

await runExclusive(async () => {
  const id = AccountId.fromBech32(addressBech32);
  if (!(await client.getAccount(id))) {
    await client.importAccountById(id);
  }
  await client.syncState();
  const account = await client.getAccount(id);
  if (!account) return;
  // StorageView (see below):
  const result = account.storage().getItem("my_slot_name");   // StorageResult | undefined
  const value = result?.toBigInt();
  // For an explicit key-based map read:
  const mapValue = account.storage().getMapItem("my_map_slot", keyWord);  // Word | undefined
});
```

`Account.storage()` returns a **`StorageView`**, a JS wrapper over the raw WASM `AccountStorage` (which is still reachable as `.raw`). `getItem(slotName)` returns a `StorageResult | undefined` that works for both Value and StorageMap slots and forwards `toBigInt()` / `toFelts()` / `toHex()` / `toU64s()`, plus `.isMap`, `.entries` and `.word`. `getMapItem(slotName, key: Word)` still returns `Word | undefined`. For the raw commitment root of a slot (the stored Word for a Value slot, the Merkle root for a map) use `getCommitment(slotName)`. Use slot-name strings, not numeric indices.

`useMidenClient()` returns the raw WASM client. Its direct methods include `getAccount(accountId)`, `getAccountStorage(accountId)`, `importAccountById(accountId)`, `syncState()`, and the transaction-request factories.

**All `new*TransactionRequest` constructors are `async` as of 0.16** and return `Promise<TransactionRequest>`: `newSendTransactionRequest`, `newMintTransactionRequest`, `newSwapTransactionRequest`, `newPswapCreateTransactionRequest`, `newPswapConsumeTransactionRequest`, `newPswapCancelTransactionRequest`, and `newConsumeTransactionRequest(notes, consumingAccountId)`. They became async so they can read the chain's fee parameters and attach fee conversion info. `newConsumeTransactionRequest` additionally **requires the consuming account**, because that is what decides whether conversion info is attached at all: attaching it for an account whose auth procedure cannot read it (a no-auth or network account) makes miden-client reject the request before execution, and omitting it where it is needed aborts the transaction on a fee-charging chain. There is no safe default, so the caller names the account.

```js
// before 0.16
const request = client.newConsumeTransactionRequest(notes);
// 0.16
const request = await client.newConsumeTransactionRequest(notes, accountId);
```

Code going through the `useConsume`, `usePswapConsume` or `usePswapCancel` hooks is unaffected - they pass the account and await for you. Only hand-rolled `useTransaction` request factories need the change.

For compile-from-source, call `await client.createCodeBuilder()` (returns `Promise<CodeBuilder>`) and use the resolved `CodeBuilder`'s `compileNoteScript(program: string)` / `compileTxScript(tx_script: string)`. The higher-level `MidenClient.accounts.getOrImport` resource API lives on the standalone `MidenClient` (see `web-client-usage`).

### Client APIs with no React hook

Some `@miden-sdk/miden-sdk` 0.16.1 additions have **no** `@miden-sdk/react` hook or type. To use them, build the `TransactionRequest` yourself against `useMidenClient()` and hand it to `useTransaction().execute({ accountId, request })`:

- `ForeignAccount.private(account)`. `useExecuteProgram()`'s `foreignAccounts` option only builds `ForeignAccount.public(id, storage)`, so a private foreign account has to go the manual route.
- `TransactionRequestBuilder.withExplicitInputNote(note, args?)`, which pins whether each input note is consumed authenticated or unauthenticated so every client executing the request produces the same transaction summary. This matters most in chain-anchored flows, where co-signers must reproduce the summary exactly.

## Account Import then Sync then Read Storage Flow

Hook-based pattern for the common "import a remote account, sync to current chain head, then read its state" workflow:

```tsx
function ImportAndInspect({ accountIdHex }: { accountIdHex: string }) {
  const { importAccount, isImporting } = useImportAccount();
  const { sync, isSyncing, syncHeight } = useSyncState();
  const { account, assets, getBalance, refetch } = useAccount(accountIdHex);

  async function load() {
    await importAccount({ type: "id", accountId: accountIdHex });
    await sync();
    await refetch();
  }
  // Render account.id, syncHeight, balances...
}
```

`useImportAccount` accepts `{ type: "id" | "file" | "seed", ... }`. After `sync()` resolves, the `useAccount(accountIdHex)` view reflects the latest chain state. The raw client methods these hooks use under the hood are `client.getAccount`, `client.importAccountById` and `client.syncState`. For the higher-level `MidenClient.accounts.*` resource API on a standalone `MidenClient` (outside React), see the `web-client-usage` skill.

## Custom Notes and .masp Package Loading

`.masp` package files (compiled MASM artifacts) are produced by `cargo miden build` in the Rust contract workspace and copied into a directory your web app serves statically (conventionally `public/packages/`). If you are using [`0xMiden/agentic-template`](https://github.com/0xMiden/agentic-template), that handoff is the step between the contract and frontend stages of its build pipeline.

> **Before hand-rolling any of this: if the note targets a network account, use `useCreateNetworkNote()`** (see "Network Notes" above). It builds the note, the `NetworkAccountTarget` attachment, the fee-aware request and the submission for you. Drop to the classes below only for shapes the hook does not cover, such as emitting several output notes in one transaction.

The example below builds a custom transaction that emits two output notes carrying fungible assets. Each note has multi-felt input storage that the note script (compiled from MASM into `.masp`) reads and asserts on at consume time. The transaction is signed and submitted by the connected wallet via `useMidenFiWallet().requestTransaction(...)`.

```tsx
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { Transaction } from "@miden-sdk/miden-wallet-adapter-base";
import {
  Package,
  NoteScript,
  Note,
  NoteAssets,
  NoteMetadata,
  NoteRecipient,
  NoteStorage,
  NoteTag,
  NoteType,
  NoteArray,
  NetworkAccountTarget,
  AccountId,
  Felt,
  FeltArray,
  FungibleAsset,
} from "@miden-sdk/miden-sdk";
import { useMidenClient } from "@miden-sdk/react";
import { randomWord } from "./lib/miden"; // your own helper

const client = useMidenClient();
const { requestTransaction } = useMidenFiWallet();

async function submitMultiNoteTx(
  senderBech32: string,
  targetBech32: string,
  faucetBech32: string,
) {
  // (a) .masp loading: fetch the pre-built artifact and decode the note script.
  const buf = await fetch("/packages/my_note.masp").then((r) => r.arrayBuffer());
  const pkg = Package.deserialize(new Uint8Array(buf));
  const noteScript = NoteScript.fromPackage(pkg);

  const sender = AccountId.fromBech32(senderBech32);
  const target = AccountId.fromBech32(targetBech32);
  const faucet = AccountId.fromBech32(faucetBech32);

  // (b) Multi-input note storage: each output note carries multiple Felt
  // inputs that the MASM script reads from its NoteStorage. Assertions on
  // these felts (e.g. "the first felt must equal the expected nonce") live
  // in the .masp script source, alongside the rest of your MASM contracts.
  function makeRecipient(seedFelts: bigint[]): NoteRecipient {
    const inputs = new FeltArray();
    for (const v of seedFelts) inputs.push(new Felt(v));
    // `new NoteRecipient(serialNum, script, storage)` takes the serial number you supply.
    // `NoteRecipient.fromScript(script, storage)` draws a fresh random one for you and is
    // what `useCreateNetworkNote` uses; prefer it unless you need a specific serial number.
    return new NoteRecipient(randomWord(), noteScript, new NoteStorage(inputs));
  }

  // (c) Asset transfers: each note carries fungible assets that move to the
  // recipient when the note is consumed. FungibleAsset is declared at
  // FungibleAsset in miden_client_web.d.ts (constructor `(faucet_id, amount: bigint)`).
  const assets1 = new NoteAssets([new FungibleAsset(faucet, 1000n)]);
  const assets2 = new NoteAssets([new FungibleAsset(faucet, 500n)]);

  const tag = NoteTag.withAccountTarget(target);
  const metadata = new NoteMetadata(sender, NoteType.Public, tag);

  // 0.16: a custom-script note CAN carry attachments. `NoteMetadata` still carries none
  // and the `Note` constructor still takes none, but `Note.withAttachments(assets,
  // metadata, recipient, attachments)` takes them, so a network-execution target reaches
  // a custom note. Build one with `new NetworkAccountTarget(targetId, executionHint?)`
  // then `.toAttachment()`; `note.isNetworkNote()` confirms the result. An arbitrary
  // payload attachment comes from `createNoteAttachment(values)` (exported by
  // `@miden-sdk/react`) and reads back with `readNoteAttachment(note)`.
  const netTarget = new NetworkAccountTarget(target, /* executionHint */ undefined);
  const attachments = [netTarget.toAttachment()];

  // Two output notes with different felt inputs and asset amounts.
  const note1 = Note.withAttachments(assets1, metadata, makeRecipient([1n, 2n, 3n]), attachments);
  const note2 = Note.withAttachments(assets2, metadata, makeRecipient([4n, 5n, 6n]), attachments);
  // Without attachments, `new Note(assets, metadata, recipient)` is still the constructor.

  // (d) Multi-output transaction: emit both notes in one transaction.
  //
  // Build the request from the FEE-AWARE builder, never a bare `new
  // TransactionRequestBuilder()`. The executing account's auth procedure pays the fee, and
  // a bare builder attaches no fee conversion info, so the transaction aborts with
  // ERR_FEE_CONVERSION_INFO_MISSING wherever the chain's verification base fee is non-zero.
  //
  // Build the NoteArray with `push`, not the array constructor: `new NoteArray([n1, n2])`
  // mirrors the wasm-bindgen `Vec<Note>` ABI and MOVES each element out of its JS handle,
  // leaving `note1` / `note2` unusable afterwards ("null pointer passed to rust" on the
  // next read). `push` borrows and keeps the handles valid.
  //
  // For transactions that consume multiple input notes simultaneously,
  // `withInputNotes(NoteAndArgsArray)` is the counterpart, and
  // `withExplicitInputNote(note, args?)` pins each note's authenticated/unauthenticated
  // status so every client reproduces the same transaction summary.
  const ownOutputs = new NoteArray();
  ownOutputs.push(note1);
  ownOutputs.push(note2);
  const builder = await client.feeAwareTransactionRequestBuilder(sender);
  const txRequest = builder.withOwnOutputNotes(ownOutputs).build();

  // (f) Submission via the wallet adapter.
  const tx = Transaction.createCustomTransaction(senderBech32, targetBech32, txRequest);
  if (!requestTransaction) throw new Error("Wallet does not support requestTransaction");
  await requestTransaction(tx);
}
```

Notes on this pattern:

- **Assertions live in MASM, not in TypeScript.** The note script compiled into `.masp` reads its `NoteStorage` felts at consume time and aborts the transaction if its assertions fail. The frontend's job is to construct and submit; MASM enforces. Author those assertions in the MASM sources of your contract workspace, not in TypeScript.
- **Single-output reference for simpler flows.** `useCreateNetworkNote()` is the in-package worked example of the single-output case, including the fee-aware builder and the `push`-not-constructor `NoteArray` discipline. Read it before hand-rolling a variant.
- **Compile from source (no `.masp`) when needed.** When the note script is not pre-bundled as `.masp`, compile it through `CodeBuilder`. **`compileNoteScript`/`compileTxScript` are methods of `CodeBuilder`, not of `WasmWebClient`.** The pattern is:

```tsx
const client = useMidenClient();
const builder = await client.createCodeBuilder();
// optionally: builder.linkStaticLibrary(myLib) or builder.linkDynamicLibrary(myLib)
const noteScript = builder.compileNoteScript(noteSourceMasm);
const txScript = builder.compileTxScript(txSourceMasm);
```

  See `CodeBuilder` and `createCodeBuilder()` in `miden_client_web.d.ts`. As the React-idiomatic alternative, `useCompile()` wraps `CompilerResource` from the standalone `MidenClient` and exposes `noteScript`, `txScript`, `component`, `isReady` at the hook layer:

```tsx
const { noteScript, isReady } = useCompile();
const script = await noteScript({
  code: noteSource,
  libraries: [{ namespace: "my_lib", code: libSource, linking: Linking.Dynamic }],
});
```
- **Inside `useTransaction`'s `request` callback** the parameter is the raw WASM client. Use `await client.createCodeBuilder()` for compile, then build the `TransactionRequest` from `await client.feeAwareTransactionRequestBuilder(accountId)` and return it. The callback may be async; `request` accepts `TransactionRequest | Promise<TransactionRequest>`. Do not re-invoke the factory if a `ChainAnchor` is in play (see "Chain-Anchored Execution"). For the higher-level `MidenClient.compile.*` and `MidenClient.transactions.execute` resource API on a standalone `MidenClient`, see `web-client-usage`.

## Cross-SDK Type Reference

The runtime types come from `@miden-sdk/react` (re-exported from `@miden-sdk/miden-sdk` for the underlying `MidenClient` types). The `.d.ts` files are the source of truth. Look them up in:

- the installed `.d.ts` for `@miden-sdk/react` (hook return types and option types)
- the installed `.d.ts` for `@miden-sdk/miden-sdk` (`MidenClient`, `Account`, `AccountId`, `Note`, `Word`, etc.)

Path layout differs across package managers - npm flattens, pnpm nests behind symlinks, and Yarn's Plug-n-Play mode serves them from a virtual filesystem with no real directory at all - so resolve them via your IDE's "Go to Definition" or the installed package surface rather than hard-coded paths.

Common app-developer types:

| Type | Source package | Notes |
|------|----------------|-------|
| `Account`, `AccountHeader` | `@miden-sdk/react` | `id`, `nonce`, `bech32id()` |
| `AccountId` | `@miden-sdk/miden-sdk` | construct via `AccountId.fromHex(hex)`; throws on invalid hex |
| `Address` | `@miden-sdk/miden-sdk` | bech32 wrapper; `Address.fromBech32(...)` |
| `Note`, `InputNoteRecord`, `ConsumableNoteRecord` | `@miden-sdk/react` | re-exported from `@miden-sdk/miden-sdk`. Input notes are received; for output-note types and private-note flows see `web-client-usage`. |
| `NoteVisibility` (constants + string-union) | `@miden-sdk/miden-sdk` | `const NoteVisibility = { Public: 'public', Private: 'private' }` plus `type NoteVisibility = 'public' \| 'private'` (`api-types.d.ts`). NOT an enum. Coexists with the raw WASM `NoteType` enum (`miden_client_web.d.ts`), which is what you use when building notes from the WASM classes directly. |
| `AccountType`, `FaucetType`, `AuthScheme`, `StorageMode` | `@miden-sdk/miden-sdk` | enums; see `web-client-usage` "Visibility & Account Types". |
| `TransactionRequest` | `@miden-sdk/react` | the client's `new*TransactionRequest` factories return `Promise<TransactionRequest>` as of 0.16 - always `await` them |
| `TransactionSummary`, `ChainAnchor` | `@miden-sdk/react` | **type-only** re-exports. Import the `ChainAnchor` class itself from `@miden-sdk/miden-sdk` to call `ChainAnchor.deserialize(bytes)` |
| `Word` | `@miden-sdk/miden-sdk` | 32-byte (4 felts) value; `Word.toU64s()` returns `BigUint64Array` of length 4 (each lane is a `bigint` after subscript). See `Word.toU64s` in `miden_client_web.d.ts`. |

Do not hardcode this table for long-term reference. The `.d.ts` files stay in lockstep with the installed package version; this list will drift.

## Rust to TypeScript Type Mapping

The Rust (`miden-client`) and TypeScript (`@miden-sdk/miden-sdk`) SDKs share concepts but diverge on naming and primitive shapes. When porting between them:

| Concept | Rust (`miden_objects` / `miden_client`) | TypeScript (`@miden-sdk/miden-sdk`) |
|---------|------------------------------------------|--------------------------------------|
| Token amount | `u64` | `bigint` |
| Field element | `Felt` (Goldilocks `u64` mod p) | `Felt` (wraps `u64`) |
| 32-byte word | `Word` (`[Felt; 4]`) | `Word`; `toU64s(): BigUint64Array` length 4 (each lane is `bigint` after subscript). |
| Account identifier | `AccountId` | `AccountId`; construct via `AccountId.fromHex` |
| Note visibility | `NoteType` enum | constants + string-union `NoteVisibility` (`'public' \| 'private'`) at the high-level `MidenClient` resource API; raw WASM `NoteType` enum (`Private = 0`, `Public = 1`) is also exported and used directly when constructing notes via the WASM classes. The two coexist; pick the layer your code lives in. |
| Account visibility / faucet kind | `AccountType` / `FaucetType` | Native builder visibility / `accounts.create({ type })` selector |
| Authentication scheme | `AuthScheme` | `AuthScheme` enum |
| Storage mode | `StorageMode` | `StorageMode` enum |

Common gotchas:

- The TS method is `FeltArray.push(element: Felt)` (`miden_client_web.d.ts`); there is no `FeltArray.append`. To convert a `Felt` to a JS `bigint`, use `Felt.asInt()` (`miden_client_web.d.ts`). When a Rust method appears missing in TS, consult `node_modules/@miden-sdk/miden-sdk/dist/index.d.ts` and `dist/crates/miden_client_web.d.ts` first instead of guessing the TS spelling.
- TS amounts are always `bigint`. Mixing `number` causes silent precision loss above `Number.MAX_SAFE_INTEGER` and `TypeError` below.
- `Word.toU64s()` returns `BigUint64Array` of length 4 (`miden_client_web.d.ts`). Each lane is a `bigint` (e.g. `word.toU64s()[0]`). Use it when reading the four `u64` lanes from a Value storage slot or building assertions on `Word` outputs.

For the canonical Rust types, see [`0xMiden/rust-sdk`](https://github.com/0xMiden/rust-sdk) (the Rust client) and the `miden_objects` crate, which lives in [`0xMiden/miden-base`](https://github.com/0xMiden/miden-base). For the canonical TS types, see `node_modules/@miden-sdk/miden-sdk/dist/index.d.ts`.

## Related Skills

Shipped alongside this one, readable out of `node_modules`:

- `testing-patterns` (this package) - mocking `@miden-sdk/react` in a consumer app's tests.
- `web-client-usage` (`@miden-sdk/miden-sdk`) - the standalone `MidenClient` resource API, for work outside React.
- `chain-anchored-execution` (`@miden-sdk/miden-sdk`) - the `ChainAnchor` surface in depth.
- `frontend-pitfalls`, `signer-integration`, `frontend-source-guide` (`@miden-sdk/miden-sdk`).
- `vite-wasm-setup` (`@miden-sdk/vite-plugin`) - bundler configuration for the WASM payload.
