import { describe, it, expect, vi, afterEach } from "vitest";
import { render, renderHook, cleanup, act } from "@testing-library/react";
import React, { useContext, useLayoutEffect, type ReactNode } from "react";
import {
  AllowedPrivateData,
  EventEmitter,
  PrivateDataPermission,
  WalletAdapterNetwork,
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
  useMidenFiWallet,
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

  it("reads createAccount from the exported WalletContext provider", () => {
    const createAccount = vi.fn();
    const value = { createAccount } as unknown as React.ContextType<
      typeof WalletContext
    >;
    const { result } = renderHook(() => useMidenFiWallet(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <WalletContext.Provider value={value}>
          {children}
        </WalletContext.Provider>
      ),
    });

    expect(result.current.createAccount).toBe(createAccount);
  });

  it("forwards caller arguments to the exported context connect", async () => {
    const createAccount = vi.fn();
    const connect = vi.fn().mockResolvedValue(undefined);
    const value = { createAccount, connect } as unknown as React.ContextType<
      typeof WalletContext
    >;
    const { result } = renderHook(() => useMidenFiWallet(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <WalletContext.Provider value={value}>
          {children}
        </WalletContext.Provider>
      ),
    });

    await expect(result.current.connect()).rejects.toThrow(
      "useMidenFiWallet connect requires privateDataPermission and network"
    );
    expect(connect).not.toHaveBeenCalled();

    await result.current.connect(
      PrivateDataPermission.UponRequest,
      WalletAdapterNetwork.Testnet,
      AllowedPrivateData.None
    );

    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith(
      PrivateDataPermission.UponRequest,
      WalletAdapterNetwork.Testnet,
      AllowedPrivateData.None
    );
  });

  it("keeps fallback connect stable while the canonical connect is stable", () => {
    const createAccount = vi.fn();
    const connect = vi.fn().mockResolvedValue(undefined);
    const seenConnects: Array<ReturnType<typeof useMidenFiWallet>["connect"]> =
      [];

    function Consumer() {
      const { connect: walletConnect } = useMidenFiWallet();

      useLayoutEffect(() => {
        seenConnects.push(walletConnect);
        void walletConnect(
          PrivateDataPermission.UponRequest,
          WalletAdapterNetwork.Testnet,
          AllowedPrivateData.None
        );
      }, [walletConnect]);

      return null;
    }

    function Host({ canonicalConnect }: { canonicalConnect: typeof connect }) {
      const value = {
        createAccount,
        connect: canonicalConnect,
      } as unknown as React.ContextType<typeof WalletContext>;

      return (
        <WalletContext.Provider value={value}>
          <Consumer />
        </WalletContext.Provider>
      );
    }

    const view = render(<Host canonicalConnect={connect} />);

    expect(connect).toHaveBeenCalledOnce();
    expect(seenConnects).toHaveLength(1);

    view.rerender(<Host canonicalConnect={connect} />);

    expect(connect).toHaveBeenCalledOnce();
    expect(seenConnects).toHaveLength(1);

    const replacementConnect = vi.fn().mockResolvedValue(undefined);
    view.rerender(<Host canonicalConnect={replacementConnect} />);

    expect(seenConnects).toHaveLength(2);
    expect(seenConnects[1]).not.toBe(seenConnects[0]);
    expect(connect).toHaveBeenCalledOnce();
    expect(replacementConnect).toHaveBeenCalledOnce();
  });

  it("keeps the provider connect identity aligned across both contexts", () => {
    const wallets: Adapter[] = [];
    const { result, rerender } = renderHook(
      () => ({ midenFi: useMidenFiWallet(), canonical: useWallet() }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <MidenFiSignerProvider wallets={wallets}>
            {children}
          </MidenFiSignerProvider>
        ),
      }
    );

    const connect = result.current.midenFi.connect;
    expect(connect).toBe(result.current.canonical.connect);

    rerender();

    expect(result.current.midenFi.connect).toBe(connect);
    expect(result.current.canonical.connect).toBe(connect);
  });

  it("still rejects WalletProvider when it has no createAccount", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const adapter = new StubAdapter();
    const wallets = [adapter as unknown as Adapter];

    expect(() => {
      renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <WalletProvider wallets={wallets}>{children}</WalletProvider>
        ),
      });
    }).toThrow("useMidenFiWallet must be used within MidenFiSignerProvider");

    consoleError.mockRestore();
  });
});
