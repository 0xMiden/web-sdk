import { createContext, useContext } from "react";
import {
  Adapter,
  AllowedPrivateData,
  MidenTransaction,
  MessageSignerWalletAdapterProps,
  PrivateDataPermission,
  SignKind,
  WalletAdapterNetwork,
  WalletName,
  WalletReadyState,
} from "@miden-sdk/miden-wallet-adapter-base";
import type { NoteFilterTypes } from "@miden-sdk/miden-sdk";

export interface Wallet {
  adapter: Adapter;
  readyState: WalletReadyState;
}

export interface WalletContextState {
  autoConnect: boolean;
  wallets: Wallet[];
  wallet: Wallet | null;
  address: string | null;
  publicKey: Uint8Array | null;
  connecting: boolean;
  connected: boolean;
  disconnecting: boolean;
  privateDataPermission?: PrivateDataPermission;

  select(walletName: WalletName): void;
  connect(
    privateDataPermission: PrivateDataPermission,
    network: WalletAdapterNetwork,
    allowedPrivateData?: AllowedPrivateData
  ): Promise<void>;
  disconnect(): Promise<void>;

  requestTransaction:
    | MessageSignerWalletAdapterProps["requestTransaction"]
    | undefined;

  requestSend: MessageSignerWalletAdapterProps["requestSend"] | undefined;

  requestConsume: MessageSignerWalletAdapterProps["requestConsume"] | undefined;

  requestAssets: MessageSignerWalletAdapterProps["requestAssets"] | undefined;

  requestGuardianInfo:
    | MessageSignerWalletAdapterProps["requestGuardianInfo"]
    | undefined;

  requestPrivateNotes:
    | MessageSignerWalletAdapterProps["requestPrivateNotes"]
    | undefined;

  signBytes: MessageSignerWalletAdapterProps["signBytes"] | undefined;

  importPrivateNote:
    | MessageSignerWalletAdapterProps["importPrivateNote"]
    | undefined;

  requestConsumableNotes:
    | MessageSignerWalletAdapterProps["requestConsumableNotes"]
    | undefined;

  waitForTransaction:
    | MessageSignerWalletAdapterProps["waitForTransaction"]
    | undefined;
}

const EMPTY_ARRAY: never[] = [];

const DEFAULT_CONTEXT = {
  autoConnect: false,
  connecting: false,
  connected: false,
  disconnecting: false,
  select(_name: WalletName) {
    console.error(constructMissingProviderErrorMessage("get", "select"));
  },
  connect(
    _privateDataPermission: PrivateDataPermission,
    _network: WalletAdapterNetwork,
    _allowedPrivateData?: AllowedPrivateData
  ) {
    return rejectMissingProvider("connect");
  },
  disconnect() {
    return rejectMissingProvider("disconnect");
  },
  requestTransaction(_transaction: MidenTransaction) {
    return rejectMissingProvider("requestTransaction");
  },
  requestAssets() {
    return rejectMissingProvider("requestAssets");
  },
  requestGuardianInfo() {
    return rejectMissingProvider("requestGuardianInfo");
  },
  requestPrivateNotes(_noteFilterType: NoteFilterTypes, _noteIds?: string[]) {
    return rejectMissingProvider("requestPrivateNotes");
  },
  signBytes(_message: Uint8Array, _kind: SignKind) {
    return rejectMissingProvider("signBytes");
  },
  importPrivateNote(_note: Uint8Array) {
    return rejectMissingProvider("importPrivateNote");
  },
  requestConsumableNotes() {
    return rejectMissingProvider("requestConsumableNotes");
  },
  waitForTransaction(_txId: string, _timeout?: number) {
    return rejectMissingProvider("waitForTransaction");
  },
  requestSend(_transaction) {
    return rejectMissingProvider("requestSend");
  },
  requestConsume(_transaction) {
    return rejectMissingProvider("requestConsume");
  },
} as WalletContextState;
Object.defineProperty(DEFAULT_CONTEXT, "wallets", {
  get() {
    console.error(constructMissingProviderErrorMessage("read", "wallets"));
    return EMPTY_ARRAY;
  },
});
Object.defineProperty(DEFAULT_CONTEXT, "wallet", {
  get() {
    console.error(constructMissingProviderErrorMessage("read", "wallet"));
    return null;
  },
});
Object.defineProperty(DEFAULT_CONTEXT, "address", {
  get() {
    console.error(constructMissingProviderErrorMessage("read", "address"));
    return null;
  },
});
Object.defineProperty(DEFAULT_CONTEXT, "publicKey", {
  get() {
    console.error(constructMissingProviderErrorMessage("read", "publicKey"));
    return null;
  },
});

function rejectMissingProvider<T = never>(valueName: string): Promise<T> {
  const message = constructMissingProviderErrorMessage("get", valueName);
  console.error(message);
  return Promise.reject(new Error(message));
}

function constructMissingProviderErrorMessage(
  action: string,
  valueName: string
) {
  return (
    "You have tried to " +
    ` ${action} "${valueName}"` +
    " on a WalletContext without providing one." +
    " Make sure to render a WalletProvider" +
    " as an ancestor of the component that uses " +
    "WalletContext"
  );
}

export const WalletContext = createContext<WalletContextState>(
  DEFAULT_CONTEXT as WalletContextState
);

export function useWallet(): WalletContextState {
  return useContext(WalletContext);
}
