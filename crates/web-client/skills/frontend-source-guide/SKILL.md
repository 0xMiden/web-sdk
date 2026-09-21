---
name: frontend-source-guide
description: Guide for advanced Miden frontend development using source repo exploration. Covers AI development practices (Plan Mode, verification-driven development, context engineering, sub-agents) and maps the Miden web-sdk source repository - the MidenClient resource API, the React SDK, the Para / Turnkey / wallet-adapter signer packages, the telemetry bindings and the WASM bindings - for discovering advanced patterns. Use when building complex applications beyond basic hook usage, implementing custom signers, working with the low-level WasmWebClient directly, or troubleshooting SDK internals.
---

# Advanced Miden Frontend Development: Source-Guided Context Engineering

## Development Approach

### 1. Plan Mode First

For any non-trivial frontend application, start in Plan Mode before writing code.

- Explore React SDK source and examples to understand available patterns
- Design the component hierarchy, data flow, and which hooks to use
- Identify which built-in hooks cover your needs vs what requires direct WasmWebClient access
- Map out the user flow: account creation, token operations, note handling

Rule of thumb: if the task involves custom transactions, external signers, or patterns not covered by the basic skills, plan first.

### 2. Verification-Driven Development

This is the single highest-leverage practice for AI-assisted frontend development.

**Type check loop**: After every file edit, run `npx tsc -b --noEmit`. The project's type check hook does this automatically. If types fail:
1. Read the error message
2. Search the React SDK source for the correct type signature or hook usage
3. Adapt the working pattern to your use case
4. Recheck

**Dev server loop**: Run `npm run dev` and check the browser. When something fails:
1. Check the browser console for WASM errors, network errors, or React errors
2. For WASM errors: check COOP/COEP headers and Vite config (see frontend-pitfalls skill)
3. For unexpected behavior: compare your code against the example wallet in the React SDK

Never submit code that doesn't type-check. The verification loop is your quality guarantee.

### 3. Context Engineering with Source Repos

The basic skills (`web-client-usage`, `react-sdk-patterns`, `frontend-pitfalls`, `vite-wasm-setup`, `chain-anchored-execution`) cover standard patterns. For anything beyond those patterns, the web-sdk source repository is the knowledge base.

**How to use source repos effectively**:
- Don't load entire repos into context. Use sub-agents to explore - they search, read relevant files, and summarize findings without filling the main conversation context.
- Read source files only when you need a specific answer (progressive disclosure)
- Look for working examples first, then adapt. The example wallet app is the most reliable reference.
- When you find a useful pattern in source, extract just what you need - the exact hook call, the exact type, the exact provider setup.

**Using sub-agents for exploration**:
- Launch an explore sub-agent with a specific question: "Find how useSwap handles the payback note type in the React SDK"
- The sub-agent searches, reads the relevant files, and returns a focused summary
- Your main context stays clean for implementation

### 4. Iterative Frontend Development

Break complex applications into stages. Complete each before starting the next:

1. **Design** (Plan Mode) - Component hierarchy, data flow, hook selection
2. **Provider setup** - MidenProvider config, signer integration if needed
3. **Query components** - Account display, balance rendering, note lists
4. **Mutation components** - Send forms, mint buttons, consume flows
5. **Transaction UX** - Stage progress, error handling, loading states
6. **Polish** - Auto-sync tuning, memoization, edge cases

When stuck at any stage: search the React SDK source for a similar working pattern. Adapt it, don't guess.

---

## Miden Source Repository Map

Clone this repo alongside your project for reference. Claude will explore it when needed for advanced patterns.

```bash
# Contains the MidenClient surface and WASM bindings (@miden-sdk/miden-sdk), the React SDK
# (@miden-sdk/react), the Para / Turnkey / wallet-adapter signer packages, and working examples
git clone --depth 1 https://github.com/0xMiden/web-sdk.git ../web-sdk
```

### `packages/react-sdk/` - React SDK Source (`@miden-sdk/react`)

The primary reference for all frontend development.

- **`src/hooks/`** - All 37 hook implementations, one file each, all re-exported from `src/index.ts` (10 query hooks + 27 mutation hooks; the file groups them under those two headings). Each file is self-contained. Read these to understand exact parameters, error handling, and stage progression.
- **`src/context/MidenProvider.tsx`** - Client initialization, sync loop, signer detection, runExclusive lock. Read this to understand initialization order. Note: `useMidenClient()` returns the `WasmWebClient` (aliased `WebClient`).
- **`src/context/SignerContext.ts`** - External signer interface. Read this when implementing custom signers.
- **`src/context/MultiSignerProvider.tsx`** - Registry that lets several signer providers coexist and hands `MidenProvider` the active one (`useMultiSigner()`).
- **`src/store/MidenStore.ts`** - Zustand store structure. Read this to understand cached state and what triggers re-renders.
- **`src/utils/`** - 17 utility modules: `accountBech32`, `accountId`, `accountParsing`, `amounts`, `asyncLock`, `bytes`, `errors`, `network`, `noteAttachment`, `noteFilters`, `notes`, `prover`, `runExclusive`, `signerAccount`, `storage`, `transactions`, `walletDetection`.
- **`src/types/index.ts`** - All TypeScript interfaces. The single source of truth for option types, result types, and configuration.
- **`packages/react-sdk/examples/wallet/`** - Complete working wallet app. The most reliable reference for how to set up MidenProvider, create accounts, display balances, claim notes, and send tokens. Caveat: its `vite.config.ts` and `src/main.tsx` still import the pre-0.16 package name `@miden-sdk/use-miden-para-react`; the package is now `@miden-sdk/para-react` (`packages/para/react/`). Copy the Miden patterns, not the Para import paths.

**Explore when**: Writing any new component, understanding exact hook behavior, finding how a specific feature works, debugging unexpected behavior.

### `crates/web-client/` - `@miden-sdk/miden-sdk`

The public client plus the Rust-to-WASM bridge underneath it.

- **`js/client.js`** - the `MidenClient` class, the recommended public entry point. Eight resource namespaces: `accounts`, `transactions`, `notes`, `tags`, `settings`, `compile`, `keystore`, `pswap`.
- **`js/resources/<area>.js`** - the implementation of each resource. Read these for behavior: locking, atomicity, polling semantics.
- **`js/types/api-types.d.ts`** - the single source of truth for the public TypeScript surface, with full JSDoc on every method and option field. Read this FIRST when asking "what can the client do".
- **`js/index.js`** - the JS `WebClient` wrapper exported as `WasmWebClient`, its method-classification sets, the forwarding `Proxy`, and the WASM call-serialization chain.
- **`js/eager.js`** - the default browser entry. Its header comment is the authoritative answer to "why does importing this await WASM at module top level, and when do I import `/lazy` instead": Capacitor WKWebView hosts (TLA hangs module evaluation indefinitely there), Next.js / SSR (TLA blocks server-side module evaluation), and framework adapters that run their own readiness state machine. See also the entry-point matrix in `crates/web-client/README.md`.
- **`js/syncLock.js`** - `withSyncLock` (plus `hasWebLocks`), the Web Locks coalescing the sync entry points use. `js/webLock.js` (`withWriteLock`) and `js/asyncLock.js` (`AsyncLock`) are neither published (absent from the package's `files` array) nor imported by any entry module - their only in-tree callers are their own tests under `js/__tests__/`. Read them for the pattern; they are not on the hot path.
- **`src/`** - the Rust `WebClient` struct, exported to JS as `WasmWebClient`. Marked `@internal` in `js/types/index.d.ts` ("Use MidenClient instead"); `useMidenClient()` from the React SDK returns this low-level client, not `MidenClient`.
- The standalone `RpcClient` struct (`getBlockHeaderByNumber`, `getNotesById`, `getAccountDetails`, `getAccountProof`, `syncNotes`, `getNetworkNoteStatus`, `getNullifierCommitHeight`, `getNoteScriptByRoot`, `syncStorageMaps`) lives in `src/rpc_client/`, and is exported separately from `@miden-sdk/miden-sdk` - it is NOT reachable through `useMidenClient()`.
- **`src/models/`** - the Rust side of every JS-visible model type (`AccountId`, `Note`, `TransactionRequest` and the rest; some are directories rather than single files). This is where a method's JS name is actually decided: `#[js_export(js_name = "...")]` on the Rust fn is what both the wasm and napi builds spell. If a name in the TypeScript surface does not match the Rust one, this attribute is why.
- **`skills/`** - the agent guides shipped with this package, including `web-client-usage` and `chain-anchored-execution`.

**Explore when**: A hook doesn't exist for your operation, understanding what client methods are available, debugging WASM-level errors.

### `crates/idxdb-store/` - IndexedDB Persistence

The browser storage layer for accounts, keys, notes, and transaction history.

- **`src/ts/schema.ts`** - the Dexie schema, its version chain, and `ensureClientVersion`: the routine that closes, `delete`s and re-opens the database whenever the running client version is a higher **major or minor** than the stored one. That is why a minor SDK bump wipes a user's locally-stored accounts, keys and notes. See `frontend-pitfalls` FP7 and the `idxdb-patterns` skill.
- **`src/ts/`** - per-table logic: `accounts.ts`, `auth.ts`, `chainData.ts`, `notes.ts`, `settings.ts`, `sync.ts`, `transactions.ts`, plus `export.ts` / `import.ts` for store dumps.

**Explore when**: Debugging data persistence issues, understanding what's stored in IndexedDB, investigating storage isolation for external signers.

### `packages/adapter/` - MidenFi browser-extension wallet adapter

`base/` (`@miden-sdk/miden-wallet-adapter-base`: `WalletAdapterNetwork`, `WalletReadyState`, `PrivateDataPermission`), `miden/` (`MidenWalletAdapter`, plus a conformance suite wallets import and run against their own providers), `react/` (`MidenFiSignerProvider`, `useWallet`), `reactui/`, `all/`.

**Explore when**: Wiring the browser-extension wallet, or gating a connect button on `readyState`.

### `packages/para/` and `packages/turnkey/` - External signer integrations

Adopted into this monorepo on the 0.16 line; they are no longer separate repositories. `core/` is `@miden-sdk/para` / `@miden-sdk/turnkey`, `react/` is `@miden-sdk/para-react` / `@miden-sdk/turnkey-react`, `create/` is the project scaffolder. The six packages dropped their `miden-` prefix on this line, so `@miden-sdk/use-miden-para-react` and `@miden-sdk/miden-turnkey-react` are pre-0.16 names.

`packages/para/react/src/ParaSignerProvider.tsx` and `packages/turnkey/react/src/TurnkeySignerProvider.tsx` are the two reference implementations of `SignerContextValue`.

**Explore when**: Implementing a custom signer - read one of these two end to end before writing your own.

### `packages/telemetry-otel/` and `packages/telemetry-sentry/` - Observability bindings

`createOtelObserver({ tracer })` and `createSentryObserver({ client })` return a callback for `ClientOptions.observer`. Neither depends on its backend, not even as a peer, so the consumer keeps control of the version and the initialization.

**Explore when**: Instrumenting SDK operation latency or failures.

### `packages/vite-plugin/` - `@miden-sdk/vite-plugin`

`src/index.ts` is the whole plugin. Read it rather than the README: the README's documented `crossOriginIsolation` default disagrees with the source (see `frontend-pitfalls` FP3 and FP8).

### `packages/node-sdk-*/` and `crates/mobile-prover/`

Platform-native binaries consumed through `optionalDependencies`, and the native mobile prover behind `TransactionProver.newCallbackProver`.

**Explore when**: Running the SDK under Node, or routing proving to a native plug-in on iOS/Android.

---

## What to Explore for Each Pattern

| Building This | Explore These Paths | What to Look For |
|---|---|---|
| Basic wallet UI | `packages/react-sdk/examples/wallet/` | MidenProvider setup, useAccounts, useSend |
| Custom transaction | `src/hooks/useTransaction.ts` | Request factory pattern, client methods |
| External signer | `src/context/SignerContext.ts`, `src/context/MultiSignerProvider.tsx` | SignerContextValue interface, signCb; MultiSignerProvider for more than one signer |
| Note consumption flow | `src/hooks/useConsume.ts` | NoteId parsing, filter construction |
| Swap UI | `src/hooks/useSwap.ts` | Swap options, dual note types |
| Partial swap (PSWAP) UI | `src/hooks/usePswapCreate.ts`, `usePswapConsume.ts`, `usePswapCancel.ts`, `usePswapCancelByOrder.ts`, `usePswapLineage.ts`, `usePswapLineages.ts`, `usePswapLineagesFor.ts` | Create, consume, cancel, and trace the partial-fill lineage |
| Token display | `src/utils/amounts.ts` | formatAssetAmount, parseAssetAmount |
| Account ID formatting | `src/utils/accountBech32.ts` | toBech32AccountId |
| State management | `src/store/MidenStore.ts` | Zustand selectors, cached state |
| Direct WasmWebClient usage | `src/context/MidenProvider.tsx` | useMidenClient(), runExclusive |
| Multi-step workflow | `src/hooks/useWaitForCommit.ts`, `useWaitForNotes.ts` | Polling, timeout patterns |
| Multisig proposal / co-signing | `src/hooks/useChainAnchor.ts`, `usePreview.ts` | ChainAnchor capture, `anchoredRequest`, TransactionSummary |
| Foreign-account (FPI) reads | `crates/web-client/js/resources/transactions.js` (`executeRequest`, `submit`) | ForeignAccount.public/private, reference-block pinning |
| Custom MASM component | `src/hooks/useCompile.ts`, `useExecuteProgram.ts` | `@account_procedure`, `@transaction_script pub proc main` |
| Network note | `src/hooks/useCreateNetworkNote.ts` | NetworkAccountTarget, createNetworkAuthComponents |
| Batch send | `src/hooks/useMultiSend.ts` | feeAwareTransactionRequestBuilder |
| Store export / import | `src/hooks/useExportStore.ts`, `useImportStore.ts` | Backup and restore |
| Live note feed | `src/hooks/useNoteStream.ts`, `useSyncControl.ts` | Subscription and sync gating |
| Prover selection and fallback | `src/utils/prover.ts` | `resolveTransactionProver`, `proveWithFallback` - what a `ProverTarget` / `ProverConfig` resolves to |
| Structured error handling | `src/utils/errors.ts` | `MidenError`, `MidenErrorCode`, `CodedError`, `WasmErrorCode` - the codes FP17 says to branch on |
| RPC URL resolution | `src/utils/network.ts` | `resolveRpcUrl` - the shorthand expansion the bech32 HRP inference then reads |
| Pausing auto-sync | `src/hooks/useSyncControl.ts` | `pauseSync` / `resumeSync` / `isPaused`; manual `sync()` still works while paused |
| Compiling MASM from the raw client | `crates/web-client/js/resources/compiler.js` | `CompilerResource` - `component`, `txScript`, `noteScript` |

Paths in this table are relative to `packages/react-sdk/` unless they name another package.

---

## Common Advanced Patterns

### Custom Hooks Wrapping WasmWebClient
For operations not covered by built-in hooks, create custom hooks over `useMidenClient()`. It returns the `WebClient` (WasmWebClient), so only call methods that exist on it - `crates/web-client/js/index.js` lists many of them in its `SYNC_METHODS` / `WRITE_METHODS` / `READ_METHODS` sets, but **those sets are not exhaustive**. `crates/web-client/scripts/check-method-classification.js` also accepts a method defined as an explicit wrapper on the JS `WebClient` class, which is how `newWallet`, `newFaucet`, `newAccountWithSecretKey`, `submitNewTransaction`, `submitNewTransactionWithProver`, `executeTransaction`, `executeTransactionAt`, `proveTransaction`, `applyTransaction`, `syncState`, `syncNoteTransport`, `syncChain` and `terminate` are reachable while appearing in none of the three sets. A name can also be both - `newAccount` is in `WRITE_METHODS` and has a class wrapper - so read the sets before concluding a method is absent from them. Check the class body too.

Wrap **multi-call sequences** in `runExclusive` so nothing interleaves between your calls (see `frontend-pitfalls` FP2). A lone call to a forwarded async method needs no wrapper: it already serializes itself through the client proxy's `_serializeWasmCall` chain. The six `SYNC_METHODS` in `js/index.js` are the exception - the proxy binds them raw and they never join that chain. Two of them take a shared WASM borrow, `lastAuthError()` and the `keystore` getter, so those still need your own lock if any other client call may be in flight.

```tsx
function useSyncHeight() {
  const client = useMidenClient();
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    // getSyncHeight is a single forwarded read, serialized by the client
    // proxy - no runExclusive needed.
    client.getSyncHeight().then(setHeight);
  }, [client]);
  return height;
}
```

Some operations are NOT on the `WebClient` returned by `useMidenClient()` - for example block headers. `getBlockHeaderByNumber` lives on the standalone `RpcClient` (exported from `@miden-sdk/miden-sdk`), which you construct directly with an endpoint:
```tsx
import { RpcClient, Endpoint } from "@miden-sdk/miden-sdk";

// Endpoint: new Endpoint(url), or the Endpoint.testnet() / Endpoint.devnet() /
// Endpoint.localhost() factories (crates/web-client/src/models/endpoint.rs:20-43).
const rpc = new RpcClient(Endpoint.testnet());

// signature: getBlockHeaderByNumber(blockNum?: number, includeMmrProof?: boolean)
const header = await rpc.getBlockHeaderByNumber(blockNumber, false);
```

### Multi-Step Workflows
Compose hooks for complex flows (mint → wait for commit → wait for notes → consume). `waitForConsumableNotes` resolves to `ConsumableNoteRecord[]`, which is **not** one of the four shapes `ConsumeOptions.notes` accepts (`string | NoteId | InputNoteRecord | Note`), so unwrap each record with `.inputNoteRecord()` first:
```tsx
const { mint } = useMint();
const { waitForCommit } = useWaitForCommit();
const { waitForConsumableNotes } = useWaitForNotes();
const { consume } = useConsume();

const mintAndConsume = async () => {
  const { transactionId } = await mint({ targetAccountId, faucetId, amount });
  await waitForCommit(transactionId);                      // default 10s timeout, 1s poll
  const records = await waitForConsumableNotes({ accountId: targetAccountId });
  await consume({
    accountId: targetAccountId,
    notes: records.map((r) => r.inputNoteRecord()),
  });
};
```

Both wait hooks default to `timeoutMs: 10000` and `intervalMs: 1000`; `waitForConsumableNotes` also takes `minCount` (default `1`). Raise the timeout for slow networks rather than looping the hook yourself.

### Custom Signer Implementation
Implement the SignerContextValue interface, wrap MidenProvider in your provider. Reference `packages/react-sdk/src/context/SignerContext.ts` for the exact interface contract. The `storeName` field must be unique per user to ensure IndexedDB isolation.

Both shipped signers live in this repo and are the two worked examples of that contract: read `packages/para/react/src/ParaSignerProvider.tsx` or `packages/turnkey/react/src/TurnkeySignerProvider.tsx` end to end before writing your own. For a guarded-multisig account, build the auth component with `createAuthGuardedMultisig` rather than compiling equivalent MASM - see the `signer-integration` skill for why the hand-rolled route breaks fee handling.
