import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import React, { useContext, type ReactNode } from "react";
import {
  EventEmitter,
  WalletReadyState,
  type Adapter,
  type WalletAdapterEvents,
  type WalletName,
} from "@miden-sdk/miden-wallet-adapter-base";

// The package entry pulls in MidenFiSignerProvider, whose `@miden-sdk/react`
// import loads the native SDK. Neither provider needs it to render here.
vi.mock("@miden-sdk/react", () => ({
  SignerContext: React.createContext(null),
}));
vi.mock("@miden-sdk/miden-sdk", () => ({}));
vi.mock("@miden-sdk/miden-wallet-adapter-miden", () => ({
  MidenWalletAdapter: vi.fn(),
}));

import {
  MidenFiSignerProvider,
  WalletContext,
  WalletProvider,
  useWallet,
} from "../index";

class StubAdapter extends EventEmitter<WalletAdapterEvents> {
  name = "Stub Wallet" as WalletName<"Stub Wallet">;
  url = "https://example.com";
  icon = "data:image/svg+xml;base64,";
  readyState = WalletReadyState.Installed;
  address: string | null = null;
  publicKey: Uint8Array | null = null;
  connecting = false;
  connected = false;
  supportedTransactionVersions = null;

  connect = vi.fn().mockImplementation(async () => {
    this.connected = true;
    this.address = "0xabc";
    this.publicKey = new Uint8Array([1, 2, 3]);
    this.emit("connect", "0xabc");
  });
  disconnect = vi.fn().mockResolvedValue(undefined);
}

const readBoth = () => ({
  viaHook: useWallet(),
  viaExport: useContext(WalletContext),
});

describe("WalletContext exported from the package entry (#484)", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("is the context WalletProvider fills", async () => {
    const adapter = new StubAdapter();
    const wallets = [adapter as unknown as Adapter];
    const { result } = renderHook(readBoth, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <WalletProvider wallets={wallets}>{children}</WalletProvider>
      ),
    });

    expect(result.current.viaExport).toBe(result.current.viaHook);
    expect(result.current.viaExport.wallets).toHaveLength(1);

    await act(() => result.current.viaExport.select(adapter.name));
    await act(async () => {
      await (result.current.viaExport.connect as () => Promise<void>)();
    });

    expect(adapter.connect).toHaveBeenCalledTimes(1);
    expect(result.current.viaExport).toBe(result.current.viaHook);
    expect(result.current.viaExport.connected).toBe(true);
    expect(result.current.viaExport.address).toBe("0xabc");
  });

  it("still reads MidenFiSignerProvider's state", () => {
    const adapter = new StubAdapter();
    const wallets = [adapter as unknown as Adapter];
    const { result } = renderHook(readBoth, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MidenFiSignerProvider wallets={wallets}>
          {children}
        </MidenFiSignerProvider>
      ),
    });

    expect(result.current.viaExport).toBe(result.current.viaHook);
    expect(result.current.viaExport.wallets[0].adapter.name).toBe(
      "Stub Wallet"
    );
  });
});
