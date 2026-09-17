---
name: testing-patterns
description: Testing conventions, mock shapes, fixtures, and TDD workflow for Miden frontend development. Covers Vitest 3 + testing-library 16 setup, React 18/19 differences, @miden-sdk/react module mocking, mocks that reproduce WASM failure modes, chain-anchored flows, and test patterns for query and mutation hooks. Use when writing, running, or debugging tests for Miden React components.
---

# Miden Frontend Testing Patterns

Written against `@miden-sdk/react` 0.16.x. This file ships inside the published tarball, so you are most likely reading it from `node_modules/@miden-sdk/react/skills/`.

**Read this first: the paths below are yours, not the SDK's.** `@miden-sdk/react` ships no mock factory, no fixtures and no pattern tests. Where this file names a path like `src/__tests__/mocks/miden-sdk-react.ts`, that is the layout the [`0xMiden/frontend-template`](https://github.com/0xMiden/frontend-template) scaffold uses; if you did not scaffold from it, create the file yourself. The *shapes* in this file come from the SDK's own types and are what matter. Sections marked "(template)" describe that scaffold and are not guarantees of the SDK.

For real, shipped reference tests, read this package's own suite at `node_modules/@miden-sdk/react/` if you have the sources, or on GitHub at `packages/react-sdk/src/__tests__/`:

| Want an example of | Read |
|---|---|
| a mutation-hook test | `src/__tests__/hooks/useSend.test.tsx` |
| a query-hook test | `src/__tests__/hooks/useAccounts.test.tsx` |
| provider ready / loading / error | `src/__tests__/context/MidenProvider.test.tsx` |
| mocking the WASM SDK wholesale | `src/__tests__/setup.ts` |

## Test Stack

What `@miden-sdk/react` itself uses, and the versions that matter:

- **Vitest 3** - test runner. The package runs 3.2.x. Its config is a standalone `defineConfig` from `vitest/config`, not a Vite-config extension.
- **@testing-library/react 16** - component rendering and queries. **Required for React 19**, because `act` moved here when React 19 removed `react-dom/test-utils`. 16 also supports React 18, so one version covers both.
- **@testing-library/dom 10** - peer of the above.
- **jsdom 24** - browser environment.

Add these in your own app if you want them; the SDK neither ships nor uses them:

- **@testing-library/user-event** - user interaction simulation.
- **@testing-library/jest-dom** - DOM assertion matchers (`toBeInTheDocument`, `toBeDisabled`).

## React 18 and 19

`@miden-sdk/react` peers on `react: ">=18.0.0"`, develops and tests against 19, and its CI runs the whole suite against **both** majors. Three things bite in tests:

- **Import `act` from `@testing-library/react`, never `react-dom/test-utils`.** React 19 removed the latter. `@testing-library/react` 16 is the version that supports React 19 and still supports 18.
- **`useRef` needs an explicit initial value under React 19's typings.** `useRef<string>()` no longer compiles; the zero-argument overload is gone. Write `useRef<string | undefined>(undefined)`. Type-only, and it compiles on 18 too. This was the single source change the SDK's own React 19 migration required.
- **To test against React 18 in a pnpm workspace, override at the ROOT manifest** (`pnpm.overrides.react`, `react-dom`, `@types/react`, `@types/react-dom`), not with a scoped `pnpm --filter <pkg> add -D react@18`. A scoped install edits one manifest and leaves every other requester free to resolve 19; a peer-resolved or deduped 19 reaching vitest turns the run into a green light that re-tested nothing. Assert the resolved version inside the job rather than trusting the override.

## Mock Factory: `@miden-sdk/react`

Mock `@miden-sdk/react` at module level with a factory **you own** - a plain object of `vi.fn()` hooks returning the shapes below. Nothing ships one inside the SDK. The template puts it at `src/__tests__/mocks/miden-sdk-react.ts`; any path works.

### Usage in test files

```tsx
// 1. Mock the entire module (hoisted to top by vitest)
vi.mock("@miden-sdk/react", () => import("./mocks/miden-sdk-react"));

// 2. Import hooks you want to override
import { useAccounts, useSend } from "@miden-sdk/react";

// 3. Override per-test
it("shows empty state", () => {
  vi.mocked(useAccounts).mockReturnValue({
    accounts: [],
    wallets: [],
    faucets: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  render(<MyComponent />);
});
```

### Default mock return values

**Query hooks** return populated data by default:
- `useAccounts()` - `{ accounts, wallets, faucets, isLoading, error, refetch }`. A template mock may keep the `wallets`/`faucets` split populated so the query-hook pattern can exercise both lists, but that is a mock artifact. **The real 0.16 hook deprecates both fields**: it returns `wallets: accounts` and `faucets: []`, because protocol 0.15 removed faucet-vs-wallet from the account id and accounts can no longer be split from headers alone. Detect faucet-ness per-account via `account.isFaucet()` on the full `Account` from `useAccount`. The real hook's `error` is also always `null`, so a mock returning an error there tests a state production never reaches.
- `useAccount()` - `{ account, assets, getBalance, isLoading, error, refetch }`; an account with a 10.0 TEST balance.
- `useNotes()` - all **four** data arrays, not two: `notes`, `consumableNotes`, `noteSummaries`, `consumableNoteSummaries`, plus `isLoading`, `error`, `refetch`. A mock returning only the first two will not typecheck.
- `useSyncState()` - `{ syncHeight: 12345, isSyncing: false, lastSyncTime, sync, error }`.
- `useAssetMetadata()` - `{ assetMetadata: new Map([[FAUCET_ID, { assetId, symbol: "TEST", decimals: 8 }]]) }`. It is a `Map` keyed by asset id, not a bare metadata object, and the hook takes a `string[]`.
- `useMiden()` - **nine** keys: `{ client, isReady: true, isInitializing: false, error: null, sync: vi.fn(), runExclusive: (fn) => fn(), prover: null, signerAccountId: null, signerConnected: null }`. Stubbing only `isReady: true` breaks any hook that awaits `sync()` or reads `prover`, and `runExclusive` must actually invoke its callback.

**Mutation hooks** return idle state by default. **Every mutation mock needs all six keys** - omitting `reset`, `error` or `result` is a type error, not a shortcut:
- `useSend()` - `{ send: vi.fn(), result: null, isLoading: false, stage: "idle", error: null, reset: vi.fn() }`. Its `result` type is `SendResult { txId, note }` - distinct from `TransactionResult { transactionId }`. `note` is non-null **only** when the call passed `returnNote: true`.
- `useMint()`, `useConsume()`, `useSwap()`, `useMultiSend()`, `useBridge()`, `usePswapCreate()`, `usePswapConsume()`, `usePswapCancel()`, `usePswapCancelByOrder()`, `useTransaction()` - same six keys, `result: TransactionResult | null`.
- `useCreateNetworkNote()` - same six keys, `result: NetworkNoteResult | null` (`{ txId, note }`).
- `useCreateWallet()` - `{ createWallet: vi.fn(), wallet: null, isCreating: false, error: null, reset: vi.fn() }`. `useCreateFaucet` mirrors it with `faucet`; `useImportAccount` with `account` and `isImporting`.

**Hooks that do not follow either shape.** These name their own busy flag, and mocking them by analogy with `useSend` gets the field names wrong:
- `useChainAnchor()` - `{ captureAnchor: vi.fn(), anchor: null, anchoredRequest: null, isCapturing: false, error: null, reset: vi.fn() }`. Its `error` is a `CodedError` carrying `code: "OPERATION_BUSY" | "INVALID_CHAIN_ANCHOR"`, so a test asserting on a failure mode should set `code`, not just `message`.
- `usePreview()` - `{ preview: vi.fn(), summary: null, isPreviewing: false, error: null, reset: vi.fn() }`, same `CodedError`.
- `useExportStore()` / `useExportNote()` - `isExporting`. `useImportStore()` / `useImportNote()` - `isImporting`.
- `useSyncControl()` - `{ pauseSync: vi.fn(), resumeSync: vi.fn() }`, no loading or error field at all.
- `useCompile()` - `{ component, txScript, noteScript, isReady }`.
- `useExecuteProgram()` - resolves `{ stack: bigint[] }`.

### Simulating transaction stages

```tsx
// Show "proving" stage
vi.mocked(useSend).mockReturnValue({
  send: vi.fn(),
  result: null,
  isLoading: true,
  stage: "proving",
  error: null,
  reset: vi.fn(),
});

// Show completed transaction - useSend returns SendResult { txId, note }
vi.mocked(useSend).mockReturnValue({
  send: vi.fn(),
  result: { txId: "0xabc123", note: null },
  isLoading: false,
  stage: "complete",
  error: null,
  reset: vi.fn(),
});

// Other mutation hooks return TransactionResult { transactionId }
vi.mocked(useMint).mockReturnValue({
  mint: vi.fn(),
  result: { transactionId: "0xdef456" },
  isLoading: false,
  stage: "complete",
  error: null,
  reset: vi.fn(),
});
```

## Fixtures (define these in your own app)

The SDK ships no fixtures. Define your own; these shapes are what the SDK's types require. The template keeps them at `src/__tests__/fixtures/`.

```tsx
import {
  WALLET_ID_1,           // "0x0a00000000000001"
  WALLET_ID_2,           // "0x0a00000000000002"
  FAUCET_ID,             // "0x0a00000000000003"
  COUNTER_ID,            // "0x0a00000000000004"
  MOCK_WALLET_HEADER,    // { id, nonce, storageCommitment }
  MOCK_FAUCET_HEADER,    // { id, nonce, storageCommitment }
  MOCK_ASSET_BALANCE,    // { assetId, amount: 1000000000n, symbol: "TEST", decimals: 8 }
  MOCK_ACCOUNT,          // { id(), nonce(), bech32id() } - all three are METHODS
  MOCK_TRANSACTION_RESULT, // { transactionId: "0x..." } - useMint / useConsume / useSwap / useMultiSend / useBridge / usePswap* / useTransaction
  MOCK_SEND_RESULT,        // { txId: "0x...", note: null }  - useSend
  MOCK_NETWORK_NOTE_RESULT,// { txId: "0x...", note }        - useCreateNetworkNote
  MOCK_NOTE_SUMMARY,       // { id, assets, sender }
} from "./fixtures";
```

Key characteristics:
- Account IDs use hex format (`0x...`) - network-agnostic test fixtures. Hooks take an `AccountRef` (`string | AccountId | Account | AccountHeader`), so a hex string is always valid input.
- Amounts are `bigint` (e.g., `1000000000n` = 10.0 with 8 decimals)
- Asset metadata uses TEST token with 8 decimals
- `id()`, `nonce()` and `bech32id()` on an `Account` are methods, so a fixture must expose them as functions, not as properties.

## Test Patterns (copy-adaptable)

The template ships reference tests under `src/__tests__/patterns/` (`provider-setup.test.tsx`, `query-hook.test.tsx`, `mutation-hook.test.tsx`) covering ready/loading/error, data/loading/error/empty, and idle/stages/success/error/argument-verification respectively. If you did not scaffold from it, read the SDK's own suite instead - it ships with the source and is listed in the table at the top of this file.

### Minimum test coverage per component

Every component test should cover:
1. **Success state** - renders correctly with data
2. **Loading state** - shows loading indicator
3. **Error state** - shows error message, recovery action
4. **User interactions** - buttons, forms trigger correct handler calls

## Wallet connection state in tests

(template) The [frontend template](https://github.com/0xMiden/frontend-template)'s wallet button (in `src/components/AppContent.tsx`) drives off **`useMidenFiWallet()`** from `@miden-sdk/miden-wallet-adapter-react`, not the generic `useSigner()`. The button gates on `wallet.readyState` (from `@miden-sdk/miden-wallet-adapter-base`) so the UI can render an "Install MidenFi Wallet" state before the extension is detected, rather than falling through to the adapter's Chrome-Web-Store fallback. When testing wallet-connect UI, mock both modules and override per test.

Setup at the top of the test file:

`useMidenFiWallet` and `WalletReadyState` kept their package names through the 0.16 adoption of the adapter packages into the web-sdk repo. (The Para and Turnkey packages did **not**: they dropped the `miden-` prefix, so `@miden-sdk/use-miden-para-react` and `@miden-sdk/miden-turnkey-react` are now `@miden-sdk/para-react` and `@miden-sdk/turnkey-react`. Fix any test that mocks the old names.)

```tsx
vi.mock("@miden-sdk/react", () => import("./mocks/miden-sdk-react"));
vi.mock("@miden-sdk/miden-wallet-adapter-react", () => ({
  useMidenFiWallet: vi.fn(() => ({
    wallet: null,
    connected: false,
    connecting: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
  })),
}));
vi.mock("@miden-sdk/miden-wallet-adapter-base", () => ({
  WalletReadyState: {
    Installed: "Installed",
    NotDetected: "NotDetected",
    Loadable: "Loadable",
    Unsupported: "Unsupported",
  },
}));

import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
```

Per-test overrides match the states the template renders:

```tsx
// extension not detected - shows disabled "Install MidenFi Wallet"
vi.mocked(useMidenFiWallet).mockReturnValue({
  wallet: { adapter: {} as never, readyState: "NotDetected" } as never,
  connected: false,
  connecting: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
} as never);

// installed + disconnected - shows "Connect Wallet"
vi.mocked(useMidenFiWallet).mockReturnValue({
  wallet: { adapter: {} as never, readyState: "Installed" } as never,
  connected: false,
  connecting: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
} as never);

// connected - shows "Disconnect Wallet"
vi.mocked(useMidenFiWallet).mockReturnValue({
  wallet: { adapter: {} as never, readyState: "Installed" } as never,
  connected: true,
  connecting: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
} as never);
```

The real `WalletContextState` has more keys than the five stubbed here (`select`, `wallets`, `publicKey`, an optional `requestTransaction`); the `as never` casts are what let a five-key stub compile. Drop a cast and you will need the rest.

(template) See `src/components/__tests__/AppContent.test.tsx` in the [frontend template](https://github.com/0xMiden/frontend-template) for the full pattern (including a `walletState()` helper that cuts per-test boilerplate).

For app code that needs the selected signer account for client-side flows (transaction-building hooks, etc.), `useMiden()` exposes `signerAccountId` / `signerConnected` as lower-level provider state - mock those via the `@miden-sdk/react` mock factory.

If your Vitest run fails resolving `@miden-sdk/miden-wallet-adapter-react` transitively, externalize it in `test.server.deps.external`. `@miden-sdk/react`'s own config takes a different route for the WASM package: it aliases `@miden-sdk/miden-sdk` and `@miden-sdk/miden-sdk/lazy` to a stub module in `vitest.config.ts` and does the real mocking in `setup.ts`. The same technique works for a consumer app that wants WASM out of the way entirely.

## Mocking Classes Called with `new`

An arrow function is not a constructor, so a module-level mock whose value is invoked with `new` in production code must be a `function` expression or a `class`. This is a JavaScript rule rather than a Vitest one; some Vitest versions surface it as `TypeError: ... is not a constructor` where others papered over it. `@miden-sdk/react` itself runs Vitest 3.2.x, so treat any claim about a specific Vitest major's enforcement as unverified and just write a constructible mock.

```ts
// WRONG: arrow function - throws when production code does `new MidenClient(...)`
vi.mock("@miden-sdk/miden-sdk", () => ({
  MidenClient: vi.fn(() => ({ /* ... */ })),
}));

// RIGHT: function expression - usable with `new`
vi.mock("@miden-sdk/miden-sdk", () => ({
  MidenClient: vi.fn(function () {
    return { /* ... */ };
  }),
}));

// ALSO RIGHT, and what @miden-sdk/react's own suite uses for WASM classes:
vi.mock("@miden-sdk/miden-sdk", () => ({
  Felt: class Felt {
    constructor(value) { this.value = value; }
    asInt() { return this.value; }
  },
  // and, for a class with statics, Object.assign over a vi.fn():
  WebClient: Object.assign(vi.fn().mockImplementation(() => mockClient), {
    createClient: vi.fn().mockResolvedValue(mockClient),
  }),
}));
```

This applies to any class mocked at module level that production code instantiates with `new` (`new MidenClient(...)`, `new WasmWebClient(...)`, `new NoteArray(...)`, etc.).

For component-level wallet adapters and hooks that are function references rather than classes (the `vi.mock("@miden-sdk/miden-wallet-adapter-react", ...)` example above), arrow-function mocks remain fine.

## Make Your Mocks Fail The Way WASM Fails

`@miden-sdk/react`'s own `src/__tests__/setup.ts` deliberately makes its mocks reproduce the two WASM failure modes that otherwise only appear in a browser. Copy the discipline into any consumer test that touches the raw client.

**1. Request constructors are `async`, so mocks must `mockResolvedValue`.** Every `new*TransactionRequest` on the client is `async fn` in Rust as of 0.16. A mock using `mockReturnValue({})` lets a hook that dropped its `await` sail through with a Promise where a `TransactionRequest` belongs, and the test passes on broken code.

```ts
// Mocks resolve, so a dropped `await` shows up here rather than in the browser.
newSendTransactionRequest: vi.fn().mockResolvedValue({}),
newConsumeTransactionRequest: vi.fn().mockResolvedValue({}),
newPswapConsumeTransactionRequest: vi.fn().mockResolvedValue({}),

// And the consumers reject a thenable outright:
const assertIsRequest = (request, method) => {
  if (request && typeof request.then === "function") {
    throw new Error(
      `${method}: expected a TransactionRequest, got a Promise - ` +
        "the request constructor's result was not awaited"
    );
  }
};
submitNewTransaction: vi.fn(async (_accountId, request) => {
  assertIsRequest(request, "submitNewTransaction");
  return { toHex: () => "0xtx" };
}),
```

Remember `newConsumeTransactionRequest(notes, consumingAccountId)` also takes the consuming account now, so assert on both arguments.

**2. wasm-bindgen MOVES values out of JS handles, and a moved handle crashes.** `new NoteArray([n1, n2])` mirrors a `Vec<Note>` ABI: it consumes each element, and the next read of `n1` throws `null pointer passed to rust`. `new NoteFilter(type, ids)` does the same to a `NoteId` list. A mock that quietly keeps working hides real move-after-use bugs, so mark the handles dead:

```ts
NoteArray: class NoteArray {
  constructor(notes) {
    this.notes = notes ?? [];
    // The array constructor MOVES; push() borrows and keeps the handle valid.
    if (notes) for (const n of notes) if (n && typeof n === "object") n._live = false;
  }
  push(note) { this.notes.push(note); }
},
sendPrivateNote: vi.fn(async (note) => {
  if (note && note._live === false) throw new Error("null pointer passed to rust");
}),
```

## Testing Chain-Anchored Flows

`useChainAnchor()` and `usePreview()` are where a wrong mock hides a real bug, because the defect is a *second* call rather than a failed one.

- Assert that the request factory is invoked **exactly once**. Re-resolving a factory redraws the fee-conversion salt and any output note's serial number, so the anchor pins a transaction nobody executes. `expect(requestFactory).toHaveBeenCalledTimes(1)` is the assertion that catches it.
- Assert that `preview` and `execute` received the **same request object** the anchor was captured for (`toBe`, not `toEqual`).
- `anchoredRequest` is state, so inside the handler that just captured it still holds the previous render's value (`null` on a first capture). A test that reads it synchronously after `captureAnchor` resolves and gets `null` is observing correct behavior, not a bug.
- Mock the error path with a `code`, not just a message: `Object.assign(new Error("busy"), { code: "OPERATION_BUSY" })`.

## Testing Time-Dependent Code (Network Sync Delay)

Production code that polls or waits on chain state should accept the delay interval as an injectable parameter rather than hardcoding it. This lets tests replace the production default (e.g. `5000` ms) with `0` so the loop drains synchronously without `vi.useFakeTimers()` plumbing.

Pattern:

```ts
// Production: optional delay parameter with a sensible default
export function pollUntilCommit(
  txId: string,
  intervalMs = 5000,            // production default
) {
  // ... uses setTimeout(..., intervalMs) or `await sleep(intervalMs)`
}

// Tests: pass 0 to skip waits
const result = await pollUntilCommit(txId, 0);
```

When the value comes from `src/config.ts` (e.g. `NETWORK_SYNC_DELAY_MS`), expose the same override there so tests can stub it via `vi.mock("@/config", ...)` without touching app code:

```ts
// src/config.ts
export const NETWORK_SYNC_DELAY_MS = Number(import.meta.env.VITE_NETWORK_SYNC_DELAY_MS ?? 5000);

// test
vi.mock("@/config", () => ({ NETWORK_SYNC_DELAY_MS: 0 }));
```

Document the production default and the test override at the call site so the contract between app code and tests is obvious.

## Automated Verification Pipeline (template)

**This section describes the [frontend template](https://github.com/0xMiden/frontend-template), not `@miden-sdk/react`.** The SDK ships no `.claude/settings.json`; if you did not scaffold from the template, treat the layout below as a suggestion to copy rather than something already wired up.

The template ships a `.claude/settings.json` that wires Claude Code hooks to enforce quality automatically. All three checks live under a single `PostToolUse` matcher (`Edit|Write`) and fire on every `.ts`/`.tsx` edit in `src/` (the typecheck and affected-tests hooks early-exit otherwise); the template ships no `Stop` hook:

1. **PostToolUse: typecheck** - `npx tsc -b --noEmit` on every `.ts`/`.tsx` edit in `src/`
2. **PostToolUse: affected tests** - `npx vitest --changed --run` on every `.ts`/`.tsx` edit in `src/`
3. **PostToolUse: full verification** - `npx vitest --run && npx tsc -b --noEmit && npx vite build` (same `Edit|Write` matcher), so the full suite + build run on each src edit rather than at task completion

If any hook fails (exit code 2), the agent is blocked from proceeding until the issue is fixed. Copy the same hook layout into your own `.claude/settings.json` to get the same enforcement locally.

## TDD Flow

```
1. Write test (describe expected behavior)
   |
2. vitest run          -> RED (test fails)
   |
3. Implement code
   |
4. Auto hooks fire     -> typecheck + affected tests   (template only)
   |
5. vitest run          -> GREEN (all pass)
   |
6. Refactor if needed
   |
7. Task complete       -> full suite + build           (template: on each src edit, PostToolUse)
```

Use your project's own runner invocation. `@miden-sdk/react` uses `vitest run`, `vitest run --coverage` and `vitest --changed --run`. If you see `yarn ...` in a Miden doc, it is stale: the SDK repo is pnpm-only.

## Common Mistakes

**Forgetting vi.clearAllMocks()**: Always call it between tests to prevent mock state leaking. `@miden-sdk/react`'s setup does it in `afterEach` alongside `cleanup()`, with `vi.resetModules()` in `beforeEach`; either placement works as long as it is global.

**Not mocking the SDK**: Components importing from `@miden-sdk/react` will fail without `vi.mock()` because the real SDK requires WASM initialization.

**Using number instead of bigint for result/fixture amounts**: Result and fixture amounts are typed strictly as `bigint` (`AssetBalance.amount`, `NoteAsset.amount`, and `useAccount().getBalance()`), so mock them with bigint literals (`1000n`, not `1000`). Hook input options (`SendOptions.amount`, `MintOptions.amount`, `MultiSendRecipient.amount`, `CreateFaucetOptions.maxSupply`) accept `bigint | number`, but prefer bigint to avoid precision loss. `SendOptions.amount` is also optional, since it is ignored when `sendAll: true`. One option deliberately **refuses** `number`: `PswapCancelByOrderOptions.orderId` is `string | bigint`, because a PSWAP order id is `u64`-shaped and routinely exceeds `Number.MAX_SAFE_INTEGER`.

**Testing implementation details**: Test what the user sees (text, buttons, states), not internal hook calls. Use `screen.getByRole`, `screen.getByText`, not internal component state.

**Forgetting the fee note**: as of 0.16, on any chain whose verification base fee is non-zero, `outputNotes()` includes the fee note, so a fixture or assertion built on `outputNotes()[0]` or on a note count is off by one. `ExecutedTransaction` has `userOutputNotes()` (without the fee note) and `feeNote()`; `TransactionRecord` and `TransactionSummary` have no split accessor. Nothing throws, which is exactly why a test is the only place this gets caught.

## Coverage, if you copy the SDK's setup

`@miden-sdk/react` enforces `lines / functions / statements >= 95` and `branches >= 94` in `vitest.config.ts`. Branches sits 1pp lower because v8's instrumentation marks `} finally {` blocks partially-covered even when both the success and rethrow paths are exercised. Two files are excluded because they need the real WASM binary rather than the jsdom mock (`src/utils/accountBech32.ts` and `src/hooks/useAssetMetadata.ts`), and are covered by the Playwright suite instead.

That split matters for a consumer too: anything depending on real `NetworkId` / `Address` / `Account.prototype` behavior, on `RpcClient`, or on the WASM sync lock is not testable in jsdom against a mocked SDK. Put those in a browser-based integration suite (`@miden-sdk/react` uses Playwright against chromium and webkit) rather than forcing a jsdom mock to imitate WASM.
