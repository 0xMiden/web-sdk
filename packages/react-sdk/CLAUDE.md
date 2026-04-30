# Miden React SDK - Usage Guide

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
    <MidenProvider config={{ rpcUrl: "testnet" }}>
      <YourApp />
    </MidenProvider>
  );
}
```

## Configuration

```tsx
<MidenProvider
  config={{
    rpcUrl: "testnet",           // "devnet" | "testnet" | "localhost" | custom URL
    prover: "testnet",           // "local" | "devnet" | "testnet" | custom URL
    autoSyncInterval: 15000,     // ms, set to 0 to disable
    noteTransportUrl: "...",     // optional: for private note delivery
  }}
  loadingComponent={<Loading />}  // shown during WASM init
  errorComponent={<Error />}      // shown on init failure
>
```

| Network | Use When |
|---------|----------|
| `devnet` | Development, testing with fake tokens |
| `testnet` | Pre-production testing |
| `localhost` | Local node at `http://localhost:57291` |

## Reading Data (Query Hooks)

Query hooks return `{ ...data, isLoading, error, refetch }` — the data fields are spread directly onto the result object, with hook-specific names (no generic `data` field).

### List Accounts
```tsx
const { accounts, wallets, faucets, isLoading } = useAccounts();

// wallets - regular accounts
// faucets - token faucets
// accounts - both, combined
```

### Get Account Details
```tsx
const { account, isLoading } = useAccount(accountId);

// account.id(), account.nonce(), account.bech32id()
// account.vault().getBalance(assetId) - get token balance
```

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
const { metadata, isLoading } = useAssetMetadata(assetId);
// metadata.symbol, metadata.decimals
```

## Writing Data (Mutation Hooks)

Mutation hooks return `{ <action>, result, isLoading, stage, error, reset }` — the action callback is named after the hook (`send`, `consume`, `mint`, ...) and the resolved value is on `result`.

**Transaction stages:** `idle` → `executing` → `proving` → `submitting` → `complete`

### Create Wallet
```tsx
const { createWallet, isLoading } = useCreateWallet();

const account = await createWallet({
  storageMode: "private",  // "private" | "public" | "network"
});
```

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

### Create Faucet
```tsx
const { createFaucet } = useCreateFaucet();

const faucet = await createFaucet({
  symbol: "TOKEN",
  decimals: 8,
  maxSupply: 1000000n,
  storageMode: "public",
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

// For advanced operations not covered by hooks
const blockHeader = await client.getBlockHeaderByNumber(100);
```

### Prevent Race Conditions
```tsx
const { runExclusive } = useMiden();

// Ensures sequential execution
await runExclusive(async (client) => {
  // Multiple operations that must not interleave
});
```

## External Signer Integration

For wallets using external key management, use the pre-built signer providers:

### Para (EVM Wallets)
```tsx
import { ParaSignerProvider } from "@miden-sdk/para";

<ParaSignerProvider apiKey="your-api-key" environment="PRODUCTION">
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</ParaSignerProvider>

// Access Para-specific data
const { para, wallet, isConnected } = useParaSigner();
```

### Turnkey
```tsx
import { TurnkeySignerProvider } from "@miden-sdk/miden-turnkey-react";

// Config is optional — defaults to https://api.turnkey.com
// and reads VITE_TURNKEY_ORG_ID from environment
<TurnkeySignerProvider>
  <MidenProvider config={{ rpcUrl: "testnet" }}>
    <App />
  </MidenProvider>
</TurnkeySignerProvider>

// Or with explicit config:
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
import { useTurnkeySigner } from "@miden-sdk/miden-turnkey-react";

// useSigner() handles connect/disconnect
const { isConnected, connect, disconnect } = useSigner();
await connect();  // triggers passkey flow, auto-selects account

// useTurnkeySigner() exposes Turnkey-specific extras
const { client, account, setAccount } = useTurnkeySigner();
```

### MidenFi Wallet Adapter
```tsx
import { MidenFiSignerProvider } from "@miden-sdk/wallet-adapter-react";

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
functionality plus any extras you provide. The field is optional — omitting it
or passing an empty array preserves the default behavior.

## Account ID Formats

Both formats work interchangeably in all hooks:

```tsx
// Hex format
useAccount("0x1234567890abcdef");

// Bech32 format
useAccount("miden1qy35...");

// Convert to bech32 for display
account.bech32id();  // "miden1qy35..."
```

## Hook Reference

Query hooks return `{ ...data, isLoading, error, refetch }`. Mutation hooks return `{ <action>, result, isLoading, stage, error, reset }`.

### Query (read)
| Hook | Data fields | Purpose |
|------|-------------|---------|
| `useAccounts()` | `accounts`, `wallets`, `faucets` | List local accounts |
| `useAccount(id)` | `account` | Account details + balances |
| `useNotes(filter?)` | `notes`, `consumableNotes`, `noteSummaries`, `consumableNoteSummaries` | Input notes + UI summaries |
| `useNoteStream(filter?)` | streaming variant of `useNotes` | Auto-updates as notes arrive |
| `useSyncState()` | `syncHeight`, `isSyncing`, `lastSyncTime`, `sync()` | Sync status + manual trigger |
| `useSyncControl()` | `pause()`, `resume()`, `isPaused` | Pause/resume the auto-sync timer |
| `useAssetMetadata(id)` | `metadata: { symbol, decimals }` | Token info |
| `useTransactionHistory(...)` | `transactions` | Local transaction log |
| `useSessionAccount()` | `account` | The signer's connected account |
| `useWaitForNotes(...)` | resolves when matching notes appear | Pull-style note waiting |

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
| `useConsume()` | `consume({ accountId, notes })` | `TransactionResult` |
| `useSwap()` | `swap({ ... })` | `TransactionResult` |
| `useTransaction()` | `transact({ ... })` | `TransactionResult` (custom tx) |
| `useExecuteProgram()` | `execute(...)` | program output |
| `useCompile()` | `compile({ source })` | `{ component, txScript, noteScript }` |
| `useWaitForCommit()` | `waitForCommit({ txId })` | resolves when committed on-chain |

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
