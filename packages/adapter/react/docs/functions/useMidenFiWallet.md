[**@miden-sdk/miden-wallet-adapter-react**](../README.md)

***

[@miden-sdk/miden-wallet-adapter-react](../README.md) / useMidenFiWallet

# Function: useMidenFiWallet()

> **useMidenFiWallet**(): [`MidenFiWalletContextState`](../interfaces/MidenFiWalletContextState.md)

Hook for MidenFi wallet operations beyond the unified useSigner interface.
Use this to access wallet-specific methods like requestTransaction, requestAssets, etc.
A package `WalletContext.Provider` whose value includes a `createAccount` function satisfies the hook, and `WalletProvider` does not.
The exported-context fallback forwards `privateDataPermission`, `network`, and optional `allowedPrivateData`, and rejects with `useMidenFiWallet connect requires privateDataPermission and network` when either required argument is omitted.
The fallback `connect` keeps the identity of the canonical `connect` it forwards to, so a rerender that passes the same function does not rerun an effect that depends on `connect`.

## Returns

[`MidenFiWalletContextState`](../interfaces/MidenFiWalletContextState.md)

## Example

```tsx
const { connected, connect, disconnect, wallets, select } = useMidenFiWallet();

// Connect
await connect();

// Request a transaction
const txId = await requestTransaction({ ... });
```
