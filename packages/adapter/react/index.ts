// Legacy exports for backward compatibility
export * from "./WalletProvider.js";
export * from "./useLocalStorage.js";
export * from "./useWallet.js";

// MidenFi Signer Provider - unified provider for @miden-sdk/react integration
export {
  MidenFiSignerProvider,
  useMidenFiWallet,
  WalletContext,
  type MidenFiSignerProviderProps,
  type SignerAccountType,
  type Wallet,
  type WalletContextState,
  type MidenFiWalletContextState,
} from "./MidenFiSignerProvider.js";
