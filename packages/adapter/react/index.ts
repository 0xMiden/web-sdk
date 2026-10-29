// Legacy exports for backward compatibility
export * from "./WalletProvider.js";
export * from "./useLocalStorage.js";
export * from "./useWallet.js";

// MidenFi Signer Provider - unified provider for @miden-sdk/react integration
export {
  MidenFiSignerProvider,
  useMidenFiWallet,
  type MidenFiSignerProviderProps,
  type SignerAccountType,
  type MidenFiWalletContextState,
} from "./MidenFiSignerProvider.js";
