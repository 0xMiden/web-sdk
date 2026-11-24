import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  renderHook,
  render,
  screen,
  cleanup,
  act,
} from "@testing-library/react";
import React from "react";

// Create a mock adapter factory
const createMockAdapter = (overrides = {}) => {
  const listeners: Record<string, Function[]> = {};
  return {
    name: "Bread Wallet",
    url: "https://chromewebstore.google.com/detail/Bread/coajhopfooegmaifelglfboehacldcbo",
    icon: "icon-data",
    readyState: "Unsupported",
    connected: false,
    address: null,
    publicKey: null,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    signBytes: vi.fn().mockResolvedValue(new Uint8Array(67)),
    createAccount: vi.fn().mockResolvedValue("account-123"),
    requestGuardianInfo: vi.fn().mockResolvedValue({
      isGuardianAccount: false,
      guardianEndpoint: null,
      guardianProvider: null,
      guardianSyncStatus: null,
    }),
    on: vi.fn((event: string, handler: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    off: vi.fn((event: string, handler: Function) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((h) => h !== handler);
      }
    }),
    emit: vi.fn((event: string, ...args: any[]) => {
      if (listeners[event]) {
        listeners[event].forEach((h) => h(...args));
      }
    }),
    ...overrides,
  };
};

let mockAdapter = createMockAdapter();

// Mock modules before imports
vi.mock("@miden-sdk/miden-wallet-adapter-miden", () => ({
  MidenWalletAdapter: vi.fn().mockImplementation((config) => {
    mockAdapter._config = config;
    return mockAdapter;
  }),
}));

vi.mock("@miden-sdk/react", () => ({
  SignerContext: React.createContext(null),
}));

vi.mock("@miden-sdk/miden-sdk", () => ({
  AccountStorageMode: {
    public: vi.fn(() => ({ toString: () => "public" })),
    private: vi.fn(() => ({ toString: () => "private" })),
    tryFromStr: vi.fn((s: string) => ({ toString: () => s })),
  },
}));

vi.mock("@miden-sdk/miden-wallet-adapter-base", () => ({
  PrivateDataPermission: {
    UponRequest: "UponRequest",
    Allowed: "Allowed",
    Denied: "Denied",
  },
  WalletAdapterNetwork: {
    Testnet: "testnet",
    Devnet: "devnet",
  },
  AllowedPrivateData: {
    None: "None",
    All: "All",
  },
  WalletReadyState: {
    Installed: "Installed",
    NotDetected: "NotDetected",
    Loadable: "Loadable",
    Unsupported: "Unsupported",
  },
  WalletNotSelectedError: class WalletNotSelectedError extends Error {
    constructor() {
      super("Wallet not selected");
    }
  },
  WalletNotReadyError: class WalletNotReadyError extends Error {
    constructor() {
      super("Wallet not ready");
    }
  },
  WalletNotConnectedError: class WalletNotConnectedError extends Error {
    constructor() {
      super("Wallet not connected");
    }
  },
}));

import { SignerContext } from "@miden-sdk/react";
import {
  MidenFiSignerProvider,
  useMidenFiWallet,
} from "../MidenFiSignerProvider";
import { useWallet } from "../useWallet";
import { MidenWalletAdapter } from "@miden-sdk/miden-wallet-adapter-miden";

// Test helpers
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MidenFiSignerProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = createMockAdapter();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  describe("rendering", () => {
    it("renders children", () => {
      render(
        <MidenFiSignerProvider>
          <div data-testid="child">Test Child</div>
        </MidenFiSignerProvider>
      );

      expect(screen.getByTestId("child")).toBeDefined();
      expect(screen.getByText("Test Child")).toBeDefined();
    });
  });

  describe("default adapter", () => {
    it("creates MidenWalletAdapter with default appName", () => {
      render(
        <MidenFiSignerProvider>
          <div>Test</div>
        </MidenFiSignerProvider>
      );

      expect(MidenWalletAdapter).toHaveBeenCalledWith({
        appName: "Miden DApp",
      });
    });

    it("creates MidenWalletAdapter with custom appName", () => {
      render(
        <MidenFiSignerProvider appName="Custom App">
          <div>Test</div>
        </MidenFiSignerProvider>
      );

      expect(MidenWalletAdapter).toHaveBeenCalledWith({
        appName: "Custom App",
      });
    });

    it("uses custom wallets when provided", () => {
      const customAdapter = createMockAdapter({ name: "Custom Wallet" });

      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider wallets={[customAdapter as any]}>
            {children}
          </MidenFiSignerProvider>
        ),
      });

      expect(result.current.wallets[0].adapter.name).toBe("Custom Wallet");
    });
  });

  describe("SignerContext when wallet not connected", () => {
    it("provides SignerContext with isConnected false when wallet not connected", async () => {
      let capturedContext: any = null;
      const TestConsumer = () => {
        const context = React.useContext(SignerContext);
        capturedContext = context;
        return null;
      };

      render(
        <MidenFiSignerProvider>
          <TestConsumer />
        </MidenFiSignerProvider>
      );

      await act(async () => {
        await flushPromises();
      });

      expect(capturedContext).not.toBeNull();
      expect(capturedContext.isConnected).toBe(false);
    });

    it("signCb throws when wallet not connected", async () => {
      let capturedContext: any = null;
      const TestConsumer = () => {
        const context = React.useContext(SignerContext);
        capturedContext = context;
        return null;
      };

      render(
        <MidenFiSignerProvider>
          <TestConsumer />
        </MidenFiSignerProvider>
      );

      await act(async () => {
        await flushPromises();
      });

      await expect(
        capturedContext.signCb(new Uint8Array(), new Uint8Array())
      ).rejects.toThrow("MidenFi wallet not connected");
    });
  });

  describe("SignerContext name", () => {
    it("includes correct name ('MidenFi')", async () => {
      let capturedContext: any = null;
      const TestConsumer = () => {
        const context = React.useContext(SignerContext);
        capturedContext = context;
        return null;
      };

      render(
        <MidenFiSignerProvider>
          <TestConsumer />
        </MidenFiSignerProvider>
      );

      await act(async () => {
        await flushPromises();
      });

      expect(capturedContext.name).toBe("MidenFi");
    });
  });

  describe("useMidenFiWallet hook", () => {
    it("throws when used outside provider", () => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      expect(() => {
        renderHook(() => useMidenFiWallet());
      }).toThrow("useMidenFiWallet must be used within MidenFiSignerProvider");

      consoleError.mockRestore();
    });

    it("returns wallet context inside provider", () => {
      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider>{children}</MidenFiSignerProvider>
        ),
      });

      expect(result.current).toBeDefined();
      expect(result.current.wallets).toBeDefined();
      expect(result.current.connect).toBeDefined();
      expect(result.current.disconnect).toBeDefined();
    });

    it("has wallets array with default MidenWalletAdapter", () => {
      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider>{children}</MidenFiSignerProvider>
        ),
      });

      expect(result.current.wallets).toHaveLength(1);
      expect(result.current.wallets[0].adapter.name).toBe("Bread Wallet");
    });

    it("connected is false initially", () => {
      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider>{children}</MidenFiSignerProvider>
        ),
      });

      expect(result.current.connected).toBe(false);
    });

    it("has select function", () => {
      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider>{children}</MidenFiSignerProvider>
        ),
      });

      expect(typeof result.current.select).toBe("function");
    });

    it("autoConnect defaults to false", () => {
      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider>{children}</MidenFiSignerProvider>
        ),
      });

      expect(result.current.autoConnect).toBe(false);
    });

    it("autoConnect can be set to true", () => {
      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider autoConnect={true}>
            {children}
          </MidenFiSignerProvider>
        ),
      });

      expect(result.current.autoConnect).toBe(true);
    });

    it("autoConnect connects an Installed wallet", async () => {
      mockAdapter = createMockAdapter({ readyState: "Installed" });
      render(
        <MidenFiSignerProvider autoConnect={true}>
          <div />
        </MidenFiSignerProvider>
      );
      await act(async () => {
        await flushPromises();
      });

      expect(mockAdapter.connect).toHaveBeenCalledTimes(1);
    });

    it("autoConnect does not retry a rejected connection", async () => {
      const onError = vi.fn();
      const rejection = new Error("User rejected the connection");
      mockAdapter = createMockAdapter({ readyState: "Installed" });
      mockAdapter.connect.mockImplementation(async () => {
        // Park a runaway retry loop so a regression fails the assertion
        // below instead of timing out the test.
        if (mockAdapter.connect.mock.calls.length > 5) {
          return new Promise(() => {});
        }
        mockAdapter.emit("error", rejection);
        throw rejection;
      });
      render(
        <MidenFiSignerProvider autoConnect={true} onError={onError}>
          <div />
        </MidenFiSignerProvider>
      );
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }

      expect(mockAdapter.connect).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(rejection);
    });

    it("autoConnect failure keeps a lone wallet selected without disconnecting", async () => {
      const onError = vi.fn();
      const rejection = new Error("User rejected the connection");
      mockAdapter = createMockAdapter({ readyState: "Installed" });
      mockAdapter.connect.mockImplementation(async () => {
        if (mockAdapter.connect.mock.calls.length > 5) {
          return new Promise(() => {});
        }
        mockAdapter.emit("error", rejection);
        throw rejection;
      });
      const removeItem = vi.spyOn(Storage.prototype, "removeItem");
      try {
        const { result } = renderHook(() => useMidenFiWallet(), {
          wrapper: ({ children }) => (
            <MidenFiSignerProvider autoConnect={true} onError={onError}>
              {children}
            </MidenFiSignerProvider>
          ),
        });
        for (let i = 0; i < 5; i++) {
          await act(async () => {
            await flushPromises();
          });
        }

        expect(mockAdapter.connect).toHaveBeenCalledTimes(1);
        expect(mockAdapter.disconnect).not.toHaveBeenCalled();
        expect(removeItem).not.toHaveBeenCalledWith("walletName");
        expect(localStorage.getItem("walletName")).toBe(
          JSON.stringify("Bread Wallet")
        );
        expect(result.current.wallet?.adapter.name).toBe("Bread Wallet");
      } finally {
        removeItem.mockRestore();
      }
    });

    it("select() retries autoConnect for the already-selected lone wallet", async () => {
      const onError = vi.fn();
      const rejection = new Error("User rejected the connection");
      mockAdapter = createMockAdapter({ readyState: "Installed" });
      mockAdapter.connect.mockImplementation(async () => {
        if (mockAdapter.connect.mock.calls.length > 5) {
          return new Promise(() => {});
        }
        mockAdapter.emit("error", rejection);
        throw rejection;
      });
      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider autoConnect={true} onError={onError}>
            {children}
          </MidenFiSignerProvider>
        ),
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }
      expect(mockAdapter.connect).toHaveBeenCalledTimes(1);

      await act(async () => {
        result.current.select("Bread Wallet" as any);
        await flushPromises();
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }

      expect(mockAdapter.connect).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledTimes(2);
    });

    it("multi-wallet autoConnect failure clears the selection and select() retries", async () => {
      const onError = vi.fn();
      const rejection = new Error("User rejected the connection");
      const adapterA = createMockAdapter({
        name: "Wallet A",
        readyState: "Installed",
      });
      adapterA.connect.mockImplementation(async () => {
        if (adapterA.connect.mock.calls.length > 5) {
          return new Promise(() => {});
        }
        adapterA.emit("error", rejection);
        throw rejection;
      });
      const adapterB = createMockAdapter({ name: "Wallet B" });
      const wallets = [adapterA, adapterB];
      localStorage.setItem("walletName", JSON.stringify("Wallet A"));

      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider
            wallets={wallets as any}
            autoConnect={true}
            onError={onError}
          >
            {children}
          </MidenFiSignerProvider>
        ),
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }

      expect(adapterA.connect).toHaveBeenCalledTimes(1);
      expect(result.current.wallet).toBeNull();
      expect(localStorage.getItem("walletName")).toBeNull();

      await act(async () => {
        result.current.select("Wallet A" as any);
        await flushPromises();
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }

      expect(adapterA.connect).toHaveBeenCalledTimes(2);
    });

    it("sole-wallet select() followed by rejected connect() does not re-trigger autoConnect or disconnect", async () => {
      const onError = vi.fn();
      const rejection = new Error("User rejected the connection");
      mockAdapter = createMockAdapter({ readyState: "Installed" });
      mockAdapter.connect.mockImplementation(async () => {
        if (mockAdapter.connect.mock.calls.length > 5) {
          return new Promise(() => {});
        }
        mockAdapter.emit("error", rejection);
        throw rejection;
      });

      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider autoConnect={true} onError={onError}>
            {children}
          </MidenFiSignerProvider>
        ),
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }
      expect(mockAdapter.connect).toHaveBeenCalledTimes(1);

      await act(async () => {
        result.current.select("Bread Wallet" as any);
        await expect(result.current.connect()).rejects.toThrow(
          "User rejected the connection"
        );
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }

      expect(mockAdapter.connect).toHaveBeenCalledTimes(2);
      expect(mockAdapter.disconnect).not.toHaveBeenCalled();
    });

    it("disconnecting a sole wallet with autoConnect does not immediately reconnect", async () => {
      mockAdapter = createMockAdapter({ readyState: "Installed" });
      mockAdapter.connect.mockImplementation(async () => {
        if (mockAdapter.connect.mock.calls.length > 5) {
          return new Promise(() => {});
        }
        mockAdapter.connected = true;
        mockAdapter.address = "mtst1testaddress";
        mockAdapter.publicKey = new Uint8Array(32);
        mockAdapter.emit("connect", "mtst1testaddress");
      });
      mockAdapter.disconnect.mockImplementation(async () => {
        mockAdapter.connected = false;
        mockAdapter.address = null;
        mockAdapter.publicKey = null;
        mockAdapter.emit("disconnect");
      });

      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider autoConnect={true}>
            {children}
          </MidenFiSignerProvider>
        ),
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }
      expect(mockAdapter.connect).toHaveBeenCalledTimes(1);
      expect(result.current.connected).toBe(true);

      await act(async () => {
        await result.current.disconnect();
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }

      expect(mockAdapter.disconnect).toHaveBeenCalledTimes(1);
      expect(mockAdapter.connect).toHaveBeenCalledTimes(1);
      expect(result.current.connected).toBe(false);
    });

    it("stale autoConnect rejection after switching wallets does not clear the new selection", async () => {
      let rejectFirst!: (err: Error) => void;
      const adapterA = createMockAdapter({
        name: "Wallet A",
        readyState: "Installed",
      });
      adapterA.connect.mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          })
      );
      const adapterB = createMockAdapter({
        name: "Wallet B",
        readyState: "Installed",
      });
      const wallets = [adapterA, adapterB];
      localStorage.setItem("walletName", JSON.stringify("Wallet A"));

      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider wallets={wallets as any} autoConnect={true}>
            {children}
          </MidenFiSignerProvider>
        ),
      });
      await act(async () => {
        await flushPromises();
      });
      expect(adapterA.connect).toHaveBeenCalledTimes(1);

      await act(async () => {
        result.current.select("Wallet B" as any);
        await flushPromises();
      });
      expect(adapterB.connect).not.toHaveBeenCalled();

      await act(async () => {
        rejectFirst(new Error("aborted"));
        await flushPromises();
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }

      expect(adapterB.connect).toHaveBeenCalledTimes(1);
      expect(result.current.wallet?.adapter.name).toBe("Wallet B");
      expect(localStorage.getItem("walletName")).toBe(
        JSON.stringify("Wallet B")
      );
    });

    it("wallets expanding mid-autoConnect preserves rejection cleanup and listener stability", async () => {
      let rejectFirst!: (err: Error) => void;
      const adapterA = createMockAdapter({
        name: "Wallet A",
        readyState: "Installed",
      });
      adapterA.connect.mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          })
      );
      const adapterB = createMockAdapter({
        name: "Wallet B",
        readyState: "Installed",
      });
      let currentWallets: any[] = [adapterA];

      const { result, rerender } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider
            wallets={currentWallets as any}
            autoConnect={true}
          >
            {children}
          </MidenFiSignerProvider>
        ),
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }
      expect(adapterA.connect).toHaveBeenCalledTimes(1);

      currentWallets = [adapterA, adapterB];
      await act(async () => {
        rerender();
        await flushPromises();
      });
      expect(
        adapterA.off.mock.calls.filter(([event]) => event === "disconnect")
      ).toHaveLength(0);

      await act(async () => {
        rejectFirst(new Error("rejected after wallets expanded"));
        await flushPromises();
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }

      expect(result.current.wallet).toBeNull();
      expect(localStorage.getItem("walletName")).toBeNull();
    });

    it("StrictMode remount and mid-flight prop update preserve autoConnect rejection cleanup", async () => {
      let rejectFirst!: (err: Error) => void;
      const adapterA = createMockAdapter({
        name: "Wallet A",
        readyState: "Installed",
      });
      adapterA.connect.mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          })
      );
      const adapterB = createMockAdapter({ name: "Wallet B" });
      const wallets = [adapterA, adapterB];
      let permission = "None" as any;
      localStorage.setItem("walletName", JSON.stringify("Wallet A"));

      const { result, rerender } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <React.StrictMode>
            <MidenFiSignerProvider
              wallets={wallets as any}
              autoConnect={true}
              privateDataPermission={permission}
            >
              {children}
            </MidenFiSignerProvider>
          </React.StrictMode>
        ),
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }
      expect(adapterA.connect).toHaveBeenCalledTimes(1);

      permission = "UponRequest";
      await act(async () => {
        rerender();
        await flushPromises();
      });

      await act(async () => {
        rejectFirst(new Error("rejected after StrictMode and prop update"));
        await flushPromises();
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }

      expect(adapterA.connect).toHaveBeenCalledTimes(1);
      expect(result.current.wallet).toBeNull();
      expect(localStorage.getItem("walletName")).toBeNull();
    });

    it("same-wallet select during in-flight autoConnect does not orphan rejection cleanup", async () => {
      let rejectFirst!: (err: Error) => void;
      const adapterA = createMockAdapter({
        name: "Wallet A",
        readyState: "Installed",
      });
      adapterA.connect.mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          })
      );
      const adapterB = createMockAdapter({ name: "Wallet B" });
      localStorage.setItem("walletName", JSON.stringify("Wallet A"));

      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider
            wallets={[adapterA, adapterB] as any}
            autoConnect={true}
          >
            {children}
          </MidenFiSignerProvider>
        ),
      });
      await act(async () => {
        await flushPromises();
      });
      expect(adapterA.connect).toHaveBeenCalledTimes(1);

      await act(async () => {
        result.current.select("Wallet A" as any);
        await flushPromises();
      });

      await act(async () => {
        rejectFirst(new Error("rejected after same-wallet select"));
        await flushPromises();
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }

      expect(result.current.wallet).toBeNull();
      expect(localStorage.getItem("walletName")).toBeNull();
    });

    it("outgoing adapter disconnect during select render lag does not clear new selection", async () => {
      const adapterA = createMockAdapter({
        name: "Wallet A",
        readyState: "Installed",
      });
      const adapterB = createMockAdapter({
        name: "Wallet B",
        readyState: "Installed",
      });
      localStorage.setItem("walletName", JSON.stringify("Wallet A"));

      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider
            wallets={[adapterA, adapterB] as any}
            autoConnect={false}
          >
            {children}
          </MidenFiSignerProvider>
        ),
      });
      await act(async () => {
        await flushPromises();
      });
      expect(result.current.wallet?.adapter.name).toBe("Wallet A");

      await act(async () => {
        result.current.select("Wallet B" as any);
        adapterA.emit("disconnect");
        await flushPromises();
      });

      expect(result.current.wallet?.adapter.name).toBe("Wallet B");
      expect(localStorage.getItem("walletName")).toBe(
        JSON.stringify("Wallet B")
      );
    });

    it("selecting an Installed wallet during pending disconnect defers autoConnect until settled", async () => {
      let resolveDisconnect!: () => void;
      const adapterA = createMockAdapter({
        name: "Wallet A",
        readyState: "Installed",
        connected: true,
        address: "mtst1a",
        publicKey: new Uint8Array(32),
      });
      adapterA.disconnect.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveDisconnect = resolve;
          })
      );
      const adapterB = createMockAdapter({
        name: "Wallet B",
        readyState: "Installed",
      });
      localStorage.setItem("walletName", JSON.stringify("Wallet A"));

      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider
            wallets={[adapterA, adapterB] as any}
            autoConnect={true}
          >
            {children}
          </MidenFiSignerProvider>
        ),
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }

      let disconnectPromise!: Promise<void>;
      await act(async () => {
        disconnectPromise = result.current.disconnect();
        adapterA.connected = false;
        adapterA.emit("disconnect");
        result.current.select("Wallet B" as any);
        await flushPromises();
      });
      expect(adapterB.connect).not.toHaveBeenCalled();

      await act(async () => {
        resolveDisconnect();
        await disconnectPromise;
        await flushPromises();
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flushPromises();
        });
      }

      expect(adapterB.connect).toHaveBeenCalledTimes(1);
      expect(result.current.wallet?.adapter.name).toBe("Wallet B");
    });

    it("stale manual connect and disconnect rejections after switching wallets do not clear the new selection", async () => {
      let rejectConnect!: (err: Error) => void;
      let rejectDisconnect!: (err: Error) => void;
      const adapterA = createMockAdapter({
        name: "Wallet A",
        readyState: "Installed",
      });
      adapterA.connect.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectConnect = reject;
          })
      );
      const adapterB = createMockAdapter({
        name: "Wallet B",
        readyState: "Installed",
      });
      localStorage.setItem("walletName", JSON.stringify("Wallet A"));

      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider
            wallets={[adapterA, adapterB] as any}
            autoConnect={false}
          >
            {children}
          </MidenFiSignerProvider>
        ),
      });
      await act(async () => {
        await flushPromises();
      });

      let connectPromise!: Promise<void>;
      await act(async () => {
        connectPromise = result.current.connect();
        result.current.select("Wallet B" as any);
        await flushPromises();
      });

      await act(async () => {
        rejectConnect(new Error("stale connect failure"));
        await expect(connectPromise).rejects.toThrow("stale connect failure");
        await flushPromises();
      });

      expect(result.current.wallet?.adapter.name).toBe("Wallet B");
      expect(localStorage.getItem("walletName")).toBe(
        JSON.stringify("Wallet B")
      );

      await act(async () => {
        result.current.select("Wallet A" as any);
        await flushPromises();
      });

      adapterA.disconnect.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectDisconnect = reject;
          })
      );
      let disconnectPromise!: Promise<void>;
      await act(async () => {
        disconnectPromise = result.current.disconnect();
        result.current.select("Wallet B" as any);
        await flushPromises();
      });

      await act(async () => {
        rejectDisconnect(new Error("stale disconnect failure"));
        await expect(disconnectPromise).rejects.toThrow(
          "stale disconnect failure"
        );
        await flushPromises();
      });

      expect(result.current.wallet?.adapter.name).toBe("Wallet B");
      expect(localStorage.getItem("walletName")).toBe(
        JSON.stringify("Wallet B")
      );
    });

    it("autoConnect does not connect a Loadable wallet", async () => {
      mockAdapter = createMockAdapter({ readyState: "Loadable" });
      render(
        <MidenFiSignerProvider autoConnect={true}>
          <div />
        </MidenFiSignerProvider>
      );
      await act(async () => {
        await flushPromises();
      });

      expect(mockAdapter.connect).not.toHaveBeenCalled();
    });

    it("exposes createAccount from adapter", () => {
      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider>{children}</MidenFiSignerProvider>
        ),
      });

      expect(result.current.createAccount).toBeDefined();
    });

    it("exposes requestGuardianInfo from adapter", () => {
      const { result } = renderHook(() => useMidenFiWallet(), {
        wrapper: ({ children }) => (
          <MidenFiSignerProvider>{children}</MidenFiSignerProvider>
        ),
      });

      expect(typeof result.current.requestGuardianInfo).toBe("function");
    });
  });

  describe("SignerContext connect/disconnect", () => {
    it("SignerContext has connect function", async () => {
      let capturedContext: any = null;
      const TestConsumer = () => {
        const context = React.useContext(SignerContext);
        capturedContext = context;
        return null;
      };

      render(
        <MidenFiSignerProvider>
          <TestConsumer />
        </MidenFiSignerProvider>
      );

      await act(async () => {
        await flushPromises();
      });

      expect(typeof capturedContext.connect).toBe("function");
    });

    it("SignerContext has disconnect function", async () => {
      let capturedContext: any = null;
      const TestConsumer = () => {
        const context = React.useContext(SignerContext);
        capturedContext = context;
        return null;
      };

      render(
        <MidenFiSignerProvider>
          <TestConsumer />
        </MidenFiSignerProvider>
      );

      await act(async () => {
        await flushPromises();
      });

      expect(typeof capturedContext.disconnect).toBe("function");
    });

    it("re-drives adapter.connect() when connect() is called again while already connected (0xMiden/wallet#470)", async () => {
      // The in-app browser preserves a dApp's JS context across a
      // park/restore, so the provider can be `connected` when the user taps
      // Connect again. A second connect() must re-drive the adapter (which
      // repopulates the current account) instead of silently no-opping.
      mockAdapter = createMockAdapter({
        readyState: "Installed",
        connect: vi.fn().mockImplementation(async () => {
          mockAdapter.connected = true;
          mockAdapter.address = "0xabc";
          mockAdapter.publicKey = new Uint8Array([1, 2, 3]);
          mockAdapter.emit("connect", "0xabc");
        }),
      });

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <MidenFiSignerProvider>{children}</MidenFiSignerProvider>
      );
      const { result } = renderHook(() => useMidenFiWallet(), { wrapper });

      // Let the provider mount + auto-select the single default wallet.
      await act(async () => {
        await flushPromises();
        await flushPromises();
      });

      await act(async () => {
        await result.current.connect();
      });
      expect(mockAdapter.connect).toHaveBeenCalledTimes(1);
      expect(result.current.connected).toBe(true);

      await act(async () => {
        await result.current.connect();
      });
      expect(mockAdapter.connect).toHaveBeenCalledTimes(2);
    });
  });

  describe("accountConfig", () => {
    it("accountType is RegularAccountImmutableCode when connected", async () => {
      // Create a connected adapter
      mockAdapter = createMockAdapter({
        connected: true,
        publicKey: new Uint8Array(32).fill(0x42),
        address: "0xtest-address",
        readyState: "Installed",
      });

      let capturedContext: any = null;
      const TestConsumer = () => {
        const context = React.useContext(SignerContext);
        capturedContext = context;
        return null;
      };

      render(
        <MidenFiSignerProvider>
          <TestConsumer />
        </MidenFiSignerProvider>
      );

      // Auto-select single wallet
      await act(async () => {
        await flushPromises();
        await flushPromises();
        await flushPromises();
      });

      if (capturedContext?.accountConfig) {
        expect(capturedContext.accountConfig.accountType).toBe(
          "RegularAccountImmutableCode"
        );
      }
    });

    it("uses custom accountType when provided", async () => {
      mockAdapter = createMockAdapter({
        connected: true,
        publicKey: new Uint8Array(32).fill(0x42),
        address: "0xtest-address",
        readyState: "Installed",
      });

      let capturedContext: any = null;
      const TestConsumer = () => {
        const context = React.useContext(SignerContext);
        capturedContext = context;
        return null;
      };

      render(
        <MidenFiSignerProvider accountType="RegularAccountUpdatableCode">
          <TestConsumer />
        </MidenFiSignerProvider>
      );

      await act(async () => {
        await flushPromises();
        await flushPromises();
        await flushPromises();
      });

      if (capturedContext?.accountConfig) {
        expect(capturedContext.accountConfig.accountType).toBe(
          "RegularAccountUpdatableCode"
        );
      }
    });

    it("uses custom storageMode when provided", async () => {
      mockAdapter = createMockAdapter({
        connected: true,
        publicKey: new Uint8Array(32).fill(0x42),
        address: "0xtest-address",
        readyState: "Installed",
      });

      let capturedContext: any = null;
      const TestConsumer = () => {
        const context = React.useContext(SignerContext);
        capturedContext = context;
        return null;
      };

      render(
        <MidenFiSignerProvider storageMode="private">
          <TestConsumer />
        </MidenFiSignerProvider>
      );

      await act(async () => {
        await flushPromises();
        await flushPromises();
        await flushPromises();
      });

      if (capturedContext?.accountConfig) {
        expect(capturedContext.accountConfig.storageMode.toString()).toBe(
          "private"
        );
      }
    });

    it("includes customComponents in accountConfig when provided", async () => {
      mockAdapter = createMockAdapter({
        connected: true,
        publicKey: new Uint8Array(32).fill(0x42),
        address: "0xtest-address",
        readyState: "Installed",
      });

      const mockComponent = { name: "test-component" } as any;

      let capturedContext: any = null;
      const TestConsumer = () => {
        const context = React.useContext(SignerContext);
        capturedContext = context;
        return null;
      };

      render(
        <MidenFiSignerProvider customComponents={[mockComponent]}>
          <TestConsumer />
        </MidenFiSignerProvider>
      );

      await act(async () => {
        await flushPromises();
        await flushPromises();
        await flushPromises();
      });

      if (capturedContext?.accountConfig) {
        expect(capturedContext.accountConfig.customComponents).toEqual([
          mockComponent,
        ]);
      }
    });

    it("does not include customComponents when not provided", async () => {
      mockAdapter = createMockAdapter({
        connected: true,
        publicKey: new Uint8Array(32).fill(0x42),
        address: "0xtest-address",
        readyState: "Installed",
      });

      let capturedContext: any = null;
      const TestConsumer = () => {
        const context = React.useContext(SignerContext);
        capturedContext = context;
        return null;
      };

      render(
        <MidenFiSignerProvider>
          <TestConsumer />
        </MidenFiSignerProvider>
      );

      await act(async () => {
        await flushPromises();
        await flushPromises();
        await flushPromises();
      });

      if (capturedContext?.accountConfig) {
        expect(capturedContext.accountConfig.customComponents).toBeUndefined();
      }
    });
  });

  describe("useWallet under MidenFiSignerProvider (issue #177)", () => {
    it("resolves useWallet() to the provider context, not DEFAULT_CONTEXT", async () => {
      // A connected adapter so the provider populates address in its context.
      mockAdapter = createMockAdapter({
        connected: true,
        publicKey: new Uint8Array(32).fill(0x42),
        address: "0xtest-address",
        readyState: "Installed",
      });

      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      // A UI-package-style consumer: reads `address` via useWallet().
      const AddressConsumer = () => {
        const { address } = useWallet();
        return <div data-testid="address">{address ?? "no-address"}</div>;
      };

      render(
        <MidenFiSignerProvider>
          <AddressConsumer />
        </MidenFiSignerProvider>
      );

      // Let the auto-select + state sync effects settle.
      await act(async () => {
        await flushPromises();
        await flushPromises();
        await flushPromises();
      });

      // Bug: reading `address` off DEFAULT_CONTEXT logs the missing-provider error.
      const missingProviderCalls = consoleError.mock.calls.filter((args) =>
        args.some(
          (a) => typeof a === "string" && a.includes("without providing one")
        )
      );
      expect(missingProviderCalls).toHaveLength(0);

      // And the address flows through to the useWallet() consumer.
      expect(screen.getByTestId("address").textContent).toBe("0xtest-address");

      consoleError.mockRestore();
    });
  });

  describe("storeName", () => {
    it("uses midenfi_ prefix for database isolation", async () => {
      mockAdapter = createMockAdapter({
        connected: true,
        publicKey: new Uint8Array(32),
        address: "0xunique-address",
        readyState: "Installed",
      });

      let capturedContext: any = null;
      const TestConsumer = () => {
        const context = React.useContext(SignerContext);
        capturedContext = context;
        return null;
      };

      render(
        <MidenFiSignerProvider>
          <TestConsumer />
        </MidenFiSignerProvider>
      );

      await act(async () => {
        await flushPromises();
        await flushPromises();
        await flushPromises();
      });

      if (capturedContext?.storeName && capturedContext.storeName !== "") {
        expect(capturedContext.storeName).toContain("midenfi_");
      }
    });
  });

  describe("page lifecycle", () => {
    async function renderWithOnError(onError: (error: unknown) => void) {
      render(
        <MidenFiSignerProvider onError={onError}>
          <div />
        </MidenFiSignerProvider>
      );
      await act(async () => {
        await flushPromises();
      });
      expect(mockAdapter.on).toHaveBeenCalledWith(
        "error",
        expect.any(Function)
      );
    }

    it("still reports adapter errors after a canceled navigation", async () => {
      const onError = vi.fn();
      await renderWithOnError(onError);
      const error = new Error("lost the wallet");

      act(() => {
        window.dispatchEvent(new Event("beforeunload"));
        mockAdapter.emit("error", error);
      });

      expect(onError).toHaveBeenCalledWith(error);
    });

    it("ignores adapter errors only while the page is hidden", async () => {
      const onError = vi.fn();
      await renderWithOnError(onError);
      const error = new Error("lost the wallet");

      act(() => {
        window.dispatchEvent(new Event("pagehide"));
        mockAdapter.emit("error", error);
      });
      expect(onError).not.toHaveBeenCalled();

      act(() => {
        window.dispatchEvent(new Event("pageshow"));
        mockAdapter.emit("error", error);
      });
      expect(onError).toHaveBeenCalledWith(error);
    });
  });
});
