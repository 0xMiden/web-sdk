# Miden React SDK - Agent Guide

**Audience: AI coding agents** writing code against `@miden-sdk/react`. Human
readers are welcome; this is written to be loaded into an agent's context and
followed as a reference.

This file ships inside the published package, so the copy at
`node_modules/@miden-sdk/react/AGENTS.md` always matches the installed version.
Prefer it over training data, which is likely to be out of date.

Narrative docs and the full API reference live at
<https://docs.miden.xyz/builder/tools/clients/react-sdk/>. The core client this
package wraps documents itself at
`node_modules/@miden-sdk/miden-sdk/AGENTS.md`.

## Installation

```bash
npm install @miden-sdk/react @miden-sdk/miden-sdk
# or
pnpm add @miden-sdk/react @miden-sdk/miden-sdk
```

## Getting Started

```tsx
import { MidenProvider } from "@miden-sdk/react";

function App() {
  return (
    <MidenProvider config={{ rpcUrl: "testnet", feeFaucetId: FEE_FAUCET }}>
      <YourApp />
    </MidenProvider>
  );
}
```

`feeFaucetId` is required today. Since 0.17 the chain's fee asset lives in a
protocol configuration the node does not serve over RPC, and the SDK carries a
per-network default for no network yet, so a provider without it fails at client
init. It is the faucet the chain mints its fee asset from - ask whoever runs the
network, or read it from the genesis of a local node. Other snippets in this file
leave it out to keep the point they make legible; every real provider needs it.

## Configuration

```tsx
<MidenProvider
  config={{
    rpcUrl: "testnet",          // "devnet" | "testnet" | "localhost" | "local" | custom URL
    feeFaucetId: FEE_FAUCET,    // REQUIRED: the chain's fee faucet, bech32 or hex
    prover: "testnet",          // "local" | "localhost" | "devnet" | "testnet" | URL
                                //   | { url, timeoutMs }
                                //   | { primary, fallback, disableFallback?, onFallback? }
    autoSyncInterval: 15000,    // ms, set to 0 to disable. Default: 15000
    noteTransportUrl: "...",    // optional: for private note delivery
    useWorker: true,            // default true; see the warning below before changing
    proverTimeoutMs: 10000,     // optional: remote-prover request timeout
    proverUrls: { testnet: "...", devnet: "..." },  // optional: override network prover URLs
    seed: seedBytes,            // optional: 32-byte Uint8Array for a deterministic RNG
  }}
  loadingComponent={<Loading />}  // shown during WASM init
  errorComponent={(error) => <Error error={error} />}  // function form receives the Error
>
```

`errorComponent` accepts either a static element or a function. Only the
function form is handed the `Error`, so use it whenever you want to show what
actually failed.

**`useWorker` has one trap worth stating up front.** It defaults to `true` and
should stay that way in browsers and extensions, so the UI stays responsive
while WASM is busy. Set it to `false` when you pass a `CallbackProver` (a native
iOS/Android prover behind a Capacitor plugin): the worker boundary serializes
the prover with `TransactionProver.serialize()`, which has no encoding for the
callback variant and **silently downgrades to `"local"`**, so your callback
never fires and nothing reports an error. Also set it to `false` in a
single-WebView native shell (Capacitor host, Tauri, Electron preload), where the
UI thread is not competing with WASM anyway.

| Network | Use When |
|---------|----------|
| `devnet` | Development, testing with fake tokens |
| `testnet` | Pre-production testing |
| `localhost` | Local node at `http://localhost:57291` |

## Reading Data (Query Hooks)

Query hooks return `{ ...data, isLoading, error, refetch }`. The data fields are spread directly onto the result object, with hook-specific names (no generic `data` field).

### List Accounts
```tsx
const { accounts, wallets, faucets, isLoading, error, refetch } = useAccounts();

// accounts - AccountHeader[] (every tracked account)
// wallets  - mirrors `accounts` (both fields are @deprecated)
// faucets  - always `[]`
```

Protocol 0.15 removed faucet-vs-wallet from the account id, so the two cannot be
split from headers alone. `wallets` is an alias of `accounts` and `faucets` is
always empty; both are marked `@deprecated`. Use `accounts`, and detect faucets
**per-account** with `account.isFaucet()` after loading the full `Account` via
`useAccount`.

`useAccounts().error` is always `null` - the hook swallows fetch failures and
leaves `accounts` at its last value, so don't gate UI on it. Read
`useMiden().error` for provider-init failures instead.

### Get Account Details
```tsx
const { account, assets, getBalance, isLoading, error, refetch } = useAccount(accountId);

// account   - Account object: .id(), .nonce(), .bech32id(), .isFaucet()
// assets    - AssetBalance[] of { assetId, amount, symbol?, decimals? }
// getBalance(faucetId) - bigint balance for one token
```

Prefer the hook's `getBalance(faucetId)`, which takes the id as a string.
`account.vault().getBalance(...)` exists but wants an `AccountId` instance, not
a string, so it throws if you hand it the same value.

### Get Notes
```tsx
const { notes, consumableNotes, noteSummaries, consumableNoteSummaries } = useNotes();

// notes - all input notes for this account
// consumableNotes - subset that's ready to claim
// noteSummaries / consumableNoteSummaries - same lists, projected to UI-friendly summaries
```

### Check Sync Status
```tsx
const { syncHeight, isSyncing, lastSyncTime, sync, error } = useSyncState();

// Manual sync
await sync();
```

### Get Token Metadata
```tsx
const { assetMetadata } = useAssetMetadata([faucetId]); // string[], NOT a bare string

// assetMetadata - Map<string, AssetMetadata>, each { assetId, symbol?, decimals? }
const meta = assetMetadata.get(faucetId);
meta?.symbol;    // "TEST"
meta?.decimals;  // 8
```

Pass an array even for a single asset. The hook calls `.filter` on its argument,
so a bare string throws a runtime `TypeError`.

## Writing Data (Mutation Hooks)

Most mutation hooks return `{ <action>, result, isLoading, stage, error, reset }`:
the action callback is named after the hook (`send`, `consume`, `mint`, ...) and
the resolved value is on `result`. That holds for `useSend`, `useMultiSend`,
`useConsume`, `useMint`, `useBridge`, `useSwap`, `useCreateNetworkNote`,
`useTransaction` and the `usePswap*` family.

**The busy flag is not `isLoading` everywhere.** Every write hook returns its
action plus `error` and `reset`, but the families differ in what they call the
in-progress flag, and only the transaction family has a `stage`:

| Family | Hooks | Busy flag | `stage`? |
|---|---|---|---|
| Transaction | `useSend`, `useMultiSend`, `useMint`, `useConsume`, `useSwap`, `useBridge`, `useCreateNetworkNote`, `useTransaction`, all four `usePswap*` writes | `isLoading` | yes |
| Account create / import | `useCreateWallet`, `useCreateFaucet`, `useImportAccount` | `isCreating` (`isImporting` for the last) | no |
| Everything else names its own | `useChainAnchor().isCapturing`, `usePreview().isPreviewing`, `useExportStore()` / `useExportNote().isExporting`, `useImportStore()` / `useImportNote().isImporting` | as named | no |

Two more sit outside the pattern entirely: `useWaitForCommit()` returns
`{ waitForCommit }` and nothing else, and `useCompile()` is not a write hook at
all (see [Hook Reference](#hook-reference)).

Destructuring `isLoading` off a hook that doesn't return one yields `undefined`,
which disables no button and reports no error. **The exported `Use*Result`
interface is authoritative over this table** - read it before destructuring.

**Transaction stages:** `idle` -> `executing` -> `proving` -> `submitting` -> `complete`

### Create Wallet
```tsx
const { createWallet, wallet, isCreating, error, reset } = useCreateWallet();

const account = await createWallet({
  storageMode: "private",  // "private" | "public". Default: "private"
  authScheme: 2,           // 2 = Falcon, 1 = ECDSA. Pass the number - see the trap below
  initSeed: seedBytes,     // optional: Uint8Array for a deterministic account id
});
```

`storageMode` is `StorageMode`, which is `"public" | "private"` only. There is
no `"network"` storage mode for a wallet - network accounts are built through
the network-account auth component, not this flag.

> **Pass `authScheme` as a number, and always pass it.** `web-sdk#223` is open:
> the create/import hooks forward `authScheme` straight to the wasm calls, which
> expect the numeric enum (`2` Falcon, `1` ECDSA). The friendly `AuthScheme`
> re-exported from this package is the string const `{ Falcon: "falcon",
> ECDSA: "ecdsa" }`, so the hooks' own default, `AuthScheme.AuthRpoFalcon512`,
> resolves to `undefined`. wasm-bindgen then throws `invalid enum value passed`
> inside a worker closure, where it does not reject the promise - **the call
> hangs instead of failing.** Omitting `authScheme` hits exactly that default.
> `skills/react-sdk-patterns/SKILL.md` has the full write-up.

### Send Tokens
```tsx
const { send, stage } = useSend();

await send({
  from: senderAccountId,
  to: recipientAccountId,
  assetId: tokenFaucetId,
  amount: 1000n,
  noteType: "private",  // "private" | "public"
});
```

### Send to Multiple Recipients
```tsx
const { multiSend } = useMultiSend();

await multiSend({
  from: senderAccountId,
  recipients: [
    { to: recipient1, assetId, amount: 500n },
    { to: recipient2, assetId, amount: 300n },
  ],
});
```

### Claim Notes
```tsx
const { consume } = useConsume();

await consume({
  accountId: myAccountId,
  notes: [noteId1, noteId2],  // note IDs, InputNoteRecords, or Note objects
});
```

### Mint Tokens (Faucet Owner)
```tsx
const { mint } = useMint();

await mint({
  faucetId: myFaucetId,
  to: recipientAccountId,
  amount: 10000n,
});
```

### Bridge Out (AggLayer)
```tsx
const { bridge } = useBridge();

// Emits a public B2AGG note that the bridge account consumes, burning the
// asset so it can be claimed at the destination Ethereum address.
await bridge({
  from: senderAccountId,
  bridgeAccount: bridgeAccountId,
  assetId: tokenFaucetId,
  amount: 100n,
  destinationNetwork: 1, // AggLayer-assigned network id
  destinationAddress: "0x000000000000000000000000000000000000dEaD",
});
```

### Create a Network Note
```tsx
const { createNetworkNote } = useCreateNetworkNote();

// Builds a Public custom-script note carrying a NetworkAccountTarget
// attachment; the targeted network account auto-consumes it on-chain.
// Provide exactly one of `script` or `recipient`.
const { txId, note } = await createNetworkNote({
  accountId: senderAccountId,
  target: networkAccountId,
  script: myNoteScript, // or: recipient: myRecipient
});

note.isNetworkNote(); // true
```

### Create Faucet
```tsx
const { createFaucet, faucet, isCreating, error, reset } = useCreateFaucet();

const account = await createFaucet({
  tokenSymbol: "TOKEN",     // required. NOT `symbol`
  tokenName: "Token",       // optional: defaults to tokenSymbol
  decimals: 8,              // Default: 8
  maxSupply: 1000000n,      // required. bigint | number
  storageMode: "public",    // "private" | "public". Default: "private"
  authScheme: 2,            // 2 = Falcon. Pass the number - see the trap above
});
```

## Common Patterns

### Show Transaction Progress
```tsx
function SendButton() {
  const { send, stage, isLoading, error } = useSend();

  const handleSend = async () => {
    try {
      await send({ from, to, assetId, amount });
    } catch (err) {
      console.error("Transaction failed:", err);
    }
  };

  return (
    <div>
      <button onClick={handleSend} disabled={isLoading}>
        {isLoading ? `${stage}...` : "Send"}
      </button>
      {error && <p>Error: {error.message}</p>}
    </div>
  );
}
```

### Format Token Amounts
```tsx
import { formatAssetAmount, parseAssetAmount } from "@miden-sdk/react";

// Display: 1000000n with 8 decimals → "0.01"
const display = formatAssetAmount(balance, 8);

// User input: "0.01" with 8 decimals → 1000000n
const amount = parseAssetAmount("0.01", 8);
```

### Display Note Summary
```tsx
import { getNoteSummary, formatNoteSummary } from "@miden-sdk/react";

const summary = getNoteSummary(note);
const text = formatNoteSummary(summary);  // "1.5 TOKEN"
```

### Wait for Transaction Confirmation
```tsx
const { waitForCommit } = useWaitForCommit();

// After sending
const result = await send({ ... });
await waitForCommit({ txId: result.txId });
```

### Access Client Directly
```tsx
const client = useMidenClient();

// For advanced operations not covered by hooks, e.g.
const height = await client.getSyncHeight();
```

**Not everything is on this client.** Block headers in particular are not:
`getBlockHeaderByNumber` lives on the standalone `RpcClient`, which you
construct yourself with an endpoint.

```tsx
import { RpcClient, Endpoint } from "@miden-sdk/miden-sdk";

// signature: getBlockHeaderByNumber(blockNum?: number, includeMmrProof?: boolean)
const rpc = new RpcClient(Endpoint.testnet());
const header = await rpc.getBlockHeaderByNumber(100, false);
```

### Pay the Fee on a Hand-Built Request

Fees are settled in the chain's native fee asset at rate 1/1, and miden-client
commits that conversion info through the transaction's auth args itself. The one
thing it will not invent is the SALT the info is committed under, because every
multisig flavour reuses that salt as its transaction summary's replay guard.

So hooks that build their own request (`useSend`, `useMultiSend`, `useConsume`,
`useMint`, `useCreateNetworkNote`, `usePswapCreate`, `usePswapConsume`,
`usePswapCancel`) declare a salt for you where the executing account needs one.
The hooks that take a request *from you* - `useTransaction`, `usePreview`,
`useChainAnchor` - cannot. A bare `new TransactionRequestBuilder()` is fine for
an ordinary account at any base fee; against a multisig on a fee-charging chain
it fails with `FeeConversionInfoRequired` naming the component. So this matters
for multisig, and for controlling the salt.

`usePswapCancelByOrder` is the exception in the first group: it resolves the
order and builds the request inside miden-client, so the SDK never declares
anything. Same split: ordinary accounts are fine, multisig is not, so cancel by
note with `usePswapCancel` there.

Ask the client for a builder that already carries it. The factory form of
`request` hands you the client, so this needs no extra plumbing:

```tsx
import { AccountId } from "@miden-sdk/miden-sdk";
import { useTransaction } from "@miden-sdk/react";

const { execute } = useTransaction();

await execute({
  accountId,
  request: async (client) =>
    (
      await client.feeAwareTransactionRequestBuilder(
        AccountId.fromHex(accountId)
      )
    )
      .withCustomScript(script)
      .build(),
});
```

The argument is the account that **executes** the request - the one whose auth
procedure pays - not the recipient. For any account that is not a multisig the builder comes
back untouched, so it is a safe drop-in; a zero base fee is not a second
condition, since 0.17 a multisig resolves its auth args whatever the chain
charges. `withAuthArg` and `withFeeConversionSalt` are mutually exclusive:
miden-client has each setter clear the other, so whichever is called last wins
rather than producing an error. Never call either on a builder this method
returned for a multisig - it already carries the three-word auth args, and
either setter discards them. Pass `feeConversionSalt` in the options instead, building a fresh `Word` per call - the parameter is moved across the WASM boundary, so a reused handle arrives as "no salt given" and one is drawn.

### Prevent Race Conditions
```tsx
const client = useMidenClient();   // throws if the provider is not ready
const { runExclusive } = useMiden();

// The callback takes NO arguments - close over the client instead.
await runExclusive(async () => {
  const height = await client.getSyncHeight();
  // further operations that must not interleave with other client calls
});
```

`runExclusive` is typed `<T>(fn: () => Promise<T>) => Promise<T>`. Writing
`async (client) => ...` binds `client` to `undefined` and fails at the first
property access, which reads like an initialization bug rather than a signature
mistake.

## External Signer Integration

For wallets using external key management, use the pre-built signer providers.
**Get the package names right - the React bindings live in their own packages,
separate from the core integration:**

| Provider | Import from | Core package (not the provider) |
|---|---|---|
| Para | `@miden-sdk/para-react` | `@miden-sdk/para` |
| Turnkey | `@miden-sdk/turnkey-react` | `@miden-sdk/turnkey` |
| MidenFi wallet | `@miden-sdk/miden-wallet-adapter-react` | `@miden-sdk/miden-wallet-adapter-base` |

### Para (EVM Wallets)
```tsx
import { ParaSignerProvider, useParaSigner } from "@miden-sdk/para-react";

<ParaSignerProvider apiKey="your-api-key" environment="PRODUCTION">
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</ParaSignerProvider>

// Access Para-specific data
const { para, wallet, isConnected } = useParaSigner();
```

`apiKey` and `environment` are both required. `environment` is one of `BETA`,
`PROD`, `SANDBOX`, `DEV`, `DEVELOPMENT`, `PRODUCTION`.

### Turnkey
```tsx
import { TurnkeySignerProvider } from "@miden-sdk/turnkey-react";

// `config` is REQUIRED and must carry `defaultOrganizationId`.
// Only `apiBaseUrl` has a default (https://api.turnkey.com).
// The provider does NOT read VITE_TURNKEY_ORG_ID or any other env var -
// read it yourself and pass it in.
<TurnkeySignerProvider
  config={{ defaultOrganizationId: import.meta.env.VITE_TURNKEY_ORG_ID }}
>
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</TurnkeySignerProvider>

// Or with the base URL set explicitly:
<TurnkeySignerProvider config={{
  apiBaseUrl: "https://api.turnkey.com",
  defaultOrganizationId: "your-org-id",
}}>
  ...
</TurnkeySignerProvider>
```

Connect via passkey authentication:
```tsx
import { useSigner } from "@miden-sdk/react";
import { useTurnkeySigner } from "@miden-sdk/turnkey-react";

// useSigner() handles connect/disconnect
const { isConnected, connect, disconnect } = useSigner();
await connect();  // triggers passkey flow, auto-selects account

// useTurnkeySigner() exposes Turnkey-specific extras
const { client, account, setAccount } = useTurnkeySigner();
```

### MidenFi Wallet Adapter
```tsx
import { MidenFiSignerProvider } from "@miden-sdk/miden-wallet-adapter-react";

<MidenFiSignerProvider network="testnet">
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</MidenFiSignerProvider>
```

### Using the Unified Signer Interface
```tsx
import { useSigner } from "@miden-sdk/react";

// Works with any signer provider above
const { isConnected, connect, disconnect, name } = useSigner();

if (!isConnected) {
  return <button onClick={connect}>Connect {name}</button>;
}
```

### Building a Custom Signer Provider
```tsx
import { SignerContext } from "@miden-sdk/react";

<SignerContext.Provider value={{
  name: "MyWallet",
  storeName: `mywallet_${userAddress}`,  // unique per user for DB isolation
  isConnected: true,
  accountConfig: {
    publicKeyCommitment: userPublicKeyCommitment,  // Uint8Array
    accountType: "RegularAccountUpdatableCode",
    storageMode: "private",
  },
  signCb: async (pubKey, signingInputs) => {
    // Route to your signing service
    return signature;  // Uint8Array
  },
  connect: async () => { /* trigger wallet connection */ },
  disconnect: async () => { /* clear session */ },
}}>
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</SignerContext.Provider>
```

### Custom Account Components

Signer providers can attach custom `AccountComponent` instances to accounts
via the `customComponents` field on `SignerAccountConfig`. This is useful for
including application-specific logic compiled from `.masp` packages (e.g. a
DEX component or custom smart contract) alongside the default auth and basic
wallet components.

```tsx
import { SignerContext, type SignerAccountConfig } from "@miden-sdk/react";
import { AccountComponent } from "@miden-sdk/miden-sdk";

// Load a compiled .masp component (e.g. from your build pipeline)
const myDexComponent: AccountComponent = await loadCompiledComponent();

const accountConfig: SignerAccountConfig = {
  publicKeyCommitment: userPublicKeyCommitment,
  accountType: "RegularAccountUpdatableCode",
  storageMode: myStorageMode,
  customComponents: [myDexComponent],
};
```

Components are appended to the `AccountBuilder` after the default basic wallet
component and before `build()` is called, so the account always includes wallet
functionality plus any extras you provide. The field is optional - omitting it
or passing an empty array preserves the default behavior.

## Account ID Formats

Both formats work interchangeably in all hooks:

```tsx
// Hex format
useAccount("0x1234567890abcdef");

// Bech32 format
useAccount("mtst1qy35...");

// Convert to bech32 for display
account.bech32id();  // "mtst1qy35..."
```

The bech32 prefix tracks the active network and is inferred from `rpcUrl`:
`mtst1` testnet, `mdev1` devnet, `mm1` mainnet. Don't hardcode a prefix and
don't pattern-match on one you invented - `miden1` is not a Miden prefix.

## Hook Reference

Query hooks return `{ ...data, isLoading, error, refetch }`. Most mutation hooks return `{ <action>, result, isLoading, stage, error, reset }`; seven do not, and the exceptions are listed under [Writing Data](#writing-data-mutation-hooks) above. The exported `Use*Result` interface always wins over this table.

### Query (read)
| Hook | Data fields | Purpose |
|------|-------------|---------|
| `useAccounts()` | `accounts` (`wallets` mirrors it, `faucets` is always `[]`; both deprecated) | List local accounts. `error` is always `null` |
| `useAccount(id)` | `account`, `assets`, `getBalance(faucetId)` | Account details + balances |
| `useNotes(filter?)` | `notes`, `consumableNotes`, `noteSummaries`, `consumableNoteSummaries` | Input notes + UI summaries |
| `useNoteStream(filter?)` | streaming variant of `useNotes` | Auto-updates as notes arrive |
| `useSyncState()` | `syncHeight`, `isSyncing`, `lastSyncTime`, `sync()` | Sync status + manual trigger |
| `useSyncControl()` | `pauseSync()`, `resumeSync()`, `isPaused` | Pause/resume the auto-sync timer |
| `useAssetMetadata(ids?)` | `assetMetadata: Map<string, AssetMetadata>` | Token info. Takes a `string[]`, never a bare string |
| `useTransactionHistory(options?)` | `records`, `record`, `status` | Local transaction log. `record` / `status` are set when you pass a single id |
| `useSessionAccount()` | `account` | The signer's connected account |
| `useWaitForNotes(...)` | resolves when matching notes appear | Pull-style note waiting |
| `usePswapLineages()` | `lineages` | All tracked PSWAP order lineages |
| `usePswapLineagesFor(creator)` | `lineages` | Tracked PSWAP lineages for one creator |
| `usePswapLineage(orderId)` | `lineage` | One tracked PSWAP lineage by stable order id |

### Mutation (write)
| Hook | Action | Returns on success |
|------|--------|--------------------|
| `useCreateWallet()` | `createWallet({ storageMode })` | `Account` |
| `useCreateFaucet()` | `createFaucet({ symbol, decimals, ... })` | `Account` |
| `useImportAccount()` | `importAccount(...)` | `Account` |
| `useImportNote()` | `importNote(...)` | imported `InputNoteRecord` |
| `useExportNote()` | `exportNote(...)` | serialized note bytes |
| `useImportStore()` / `useExportStore()` | store import/export | bytes / `void` |
| `useSend()` | `send({ from, to, assetId, amount, noteType })` | `SendResult` (with `txId`, `note`) |
| `useMultiSend()` | `multiSend({ from, recipients })` | `TransactionResult` |
| `useMint()` | `mint({ faucetId, to, amount })` | `TransactionResult` |
| `useBridge()` | `bridge({ from, bridgeAccount, assetId, amount, destinationNetwork, destinationAddress })` | `TransactionResult` (emits an AggLayer B2AGG bridge-out note) |
| `useCreateNetworkNote()` | `createNetworkNote({ accountId, target, script \| recipient, ... })` | `NetworkNoteResult` (`{ txId, note }`; note satisfies `note.isNetworkNote()`) |
| `useConsume()` | `consume({ accountId, notes })` | `TransactionResult` |
| `useSwap()` | `swap({ ... })` | `TransactionResult` |
| `usePswapCreate()` | `pswapCreate({ accountId, offeredFaucetId, offeredAmount, requestedFaucetId, requestedAmount, ... })` | `TransactionResult` (creates partial-swap note) |
| `usePswapConsume()` | `pswapConsume({ accountId, note, fillAmount, noteFillAmount? })` - `note` accepts hex string \| `NoteId` \| `InputNoteRecord` \| `Note` | `TransactionResult` (fills PSWAP fully or partially) |
| `usePswapCancel()` | `pswapCancel({ accountId, note })` - creator only, reclaims unfilled offered asset | `TransactionResult` |
| `usePswapCancelByOrder()` | `pswapCancelByOrder({ orderId })` - creator only, resolves the current tip + creator from the tracked lineage | `TransactionResult` |
| `useTransaction()` | `execute({ ..., anchor? })` | `TransactionResult` (custom tx; `anchor` pins the reference block) |
| `useChainAnchor()` | `captureAnchor({ request })` | `ChainAnchor` (pins the current reference block for later replay) |
| `usePreview()` | `preview({ accountId, request, anchor? })` | `TransactionSummary` awaiting authorization; rejects `TRANSACTION_ALREADY_AUTHORIZED` when none is pending |
| `useExecuteProgram()` | `execute(...)` | program output |
| `useWaitForCommit()` | `waitForCommit({ txId })` | resolves when committed on-chain. Returns `{ waitForCommit }` only - no `result`, `isLoading`, `stage`, `error` or `reset` |

### Not a mutation hook

`useCompile()` returns `{ component, txScript, noteScript, isReady }`, where the
first three are themselves async compile functions wrapping `CompilerResource`.
There is no `compile` callback, no `isLoading` and no `reset`, and the options
field is `code`, not `source`:

```tsx
const { noteScript, isReady } = useCompile();

const script = await noteScript({
  code: noteSource,
  libraries: [{ namespace: "my_lib", code: libSource, linking: Linking.Dynamic }],
});
```

### Context (provider access)

These read provider state rather than chain state, so they have no `refetch` and
no `isLoading` of their own.

| Hook | Returns | Purpose |
|------|---------|---------|
| `useMiden()` | `client`, `isReady`, `isInitializing`, `error`, `sync`, `runExclusive`, `prover`, `signerAccountId`, `signerConnected` | Provider state and the WASM serialization lock. Throws outside a `MidenProvider` |
| `useMidenClient()` | `WebClient` | The raw client. **Throws** if the provider is not ready, so guard on `useMiden().isReady` |
| `useSigner()` | `isConnected`, `connect`, `disconnect`, `name` | The unified external-signer interface, whichever provider is mounted |
| `useMultiSigner()` | `signers`, `activeSigner`, `connectSigner(name)`, `disconnectSigner()`, or **`null`** | Choosing between several signer providers. Returns `null` outside a `MultiSignerProvider` rather than throwing, so null-check it |

## Chain-Anchored Execution

Whenever one party signs a transaction summary and another party (or the same
party, later) executes it, every party has to derive the same summary. How
depends on what the summary binds.

**Multisig proposals (0.17+): no anchor.** A multisig summary binds a bound
block named in its auth args. Build the request with
`client.feeAwareTransactionRequestBuilder(accountId)`, which binds the current
sync height and declares it with `withBlockNumbers`, and ship the request
bytes. Every party previews and executes at its own tip once its client has
synced to at least the bound block (the largest of `request.blockNumbers()`);
below it the call fails with `requested block N is after transaction reference
block M` until it syncs. `usePreview` does not sync, and `useTransaction` syncs
through the provider's `sync()`, which returns early while another sync runs, so
sync and then check the height before previewing or executing.

```tsx
import { TransactionRequest } from "@miden-sdk/miden-sdk";

const { client, sync } = useMiden();
const { preview } = usePreview();
const { execute } = useTransaction();

// Proposer: resolve the request once and ship its bytes - a rebuild draws a
// new salt, so it would bind a different summary.
const request = (await client.feeAwareTransactionRequestBuilder(accountId))
  .withCustomScript(script)
  .build();
const summary = await preview({ accountId, request });

// Co-signer: re-derive from the proposer's bytes at the local tip and compare.
const received = TransactionRequest.deserialize(requestBytes);
await sync();
// The provider's sync() can return without reaching the tip (it returns early
// while another sync runs), so confirm the height before using the proposal.
const bound = Math.max(0, ...received.blockNumbers());
if ((await client.getSyncHeight()) < bound) {
  throw new Error("not synced to the proposal's bound block yet; retry");
}
const derived = await preview({ accountId, request: received });

// Executor: submit at the tip, after the same sync and height check.
await execute({ accountId, request: received, skipSync: true });
```

Do not re-execute a multisig proposal at an anchor: a node keeps account state
for only 50 blocks, so anchored re-execution of an older proposal fails with
`block N has been pruned`.

**Summaries that bind the reference block (single-signature co-signing):
anchor.** `useChainAnchor` captures that block; `usePreview` and
`useTransaction` replay against it.

```tsx
const { captureAnchor, isCapturing } = useChainAnchor();
const { preview, isPreviewing } = usePreview();
const { execute } = useTransaction();

// Signer: pin the reference block alongside the request.
const anchor = await captureAnchor({ request });

// Co-signer: rebuild the same summary from the same anchor and inspect it
// before authorizing. Rejects TRANSACTION_ALREADY_AUTHORIZED if none is pending.
const summary = await preview({ accountId, request, anchor });

// Executor: run it against the pinned block.
await execute({ accountId, request, anchor });
```

Without an anchor, each party deriving such a summary executes against its own
sync height, the summaries commit to different reference blocks, and the
commitments never match.
If you are debugging co-signers whose commitments disagree, or
`INVALID_CHAIN_ANCHOR` / `STALE_CLIENT` / `OPERATION_BUSY`, read
`node_modules/@miden-sdk/miden-sdk/skills/chain-anchored-execution/SKILL.md`
before changing anything - the failure modes there are not guessable from the
type signatures.

An anchor pins the reference block and chain data only. It does not pin account
state, so a matching commitment does not by itself prove the two parties agree
on the account.

## Type Imports

```tsx
import type {
  // Config
  MidenConfig,

  // Hook results
  QueryResult,
  MutationResult,
  AccountsResult,

  // SDK types (re-exported)
  Account,
  AccountId,
  Note,
  TransactionRecord,
  FungibleAsset,
} from "@miden-sdk/react";
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Client not ready" | Wrap component in `MidenProvider`, check `useMiden().isReady` |
| Transaction stuck | Check `stage` value, network connectivity, prover availability |
| Notes not appearing | Call `sync()` manually, check `autoSyncInterval` config |
| Bech32 address wrong | Verify `rpcUrl` matches intended network |
| WASM init fails | Check browser compatibility, ensure WASM served with correct MIME type |
