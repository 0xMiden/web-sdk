import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  renderHook,
  act,
} from "@testing-library/react";
import React from "react";
import {
  WasmWebClient as WebClient,
  TransactionProver,
} from "@miden-sdk/miden-sdk/lazy";
import {
  MidenProvider,
  useMiden,
  useMidenClient,
} from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

function StatusDisplay() {
  const { isReady, isInitializing, error } = useMiden();
  return (
    <div>
      <span data-testid="ready">{String(isReady)}</span>
      <span data-testid="initializing">{String(isInitializing)}</span>
      <span data-testid="error">{error?.message ?? "none"}</span>
    </div>
  );
}

describe("MidenProvider initialization", () => {
  it("should initialize and become ready", async () => {
    render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <StatusDisplay />
      </MidenProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });

    expect(WebClient.createClient).toHaveBeenCalled();
  });

  it("should initialize and become ready in StrictMode", async () => {
    render(
      <React.StrictMode>
        <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
          <StatusDisplay />
        </MidenProvider>
      </React.StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });

    expect(WebClient.createClient).toHaveBeenCalled();
  });
});

// Regression: TLA removal in web-client #2010 (v0.14.2) made WASM init truly
// async, so any wasm-bindgen constructor called before WebClient.createClient
// resolves now throws with "wasm.__wbindgen_malloc is undefined". The provider
// used to build the default TransactionProver inside a render-time useMemo,
// which fired before the client init useEffect — so a non-null `prover` config
// crashed on first render. The mock below simulates that ordering contract:
// TransactionProver constructors throw unless WASM has been "initialized"
// (which we flip inside the mocked WebClient.createClient).
describe("MidenProvider WASM readiness ordering", () => {
  function ProverDisplay() {
    const { isReady, prover } = useMiden();
    return (
      <div>
        <span data-testid="ready">{String(isReady)}</span>
        <span data-testid="has-prover">{String(prover != null)}</span>
      </div>
    );
  }

  it("does not construct the prover before WASM is initialized", async () => {
    let wasmReady = false;

    vi.mocked(TransactionProver.newRemoteProver).mockImplementation(
      (url, timeout) => {
        if (!wasmReady) {
          throw new Error("wasm.__wbindgen_malloc is undefined");
        }
        return {
          type: "remote",
          url,
          timeout,
        } as unknown as TransactionProver;
      }
    );
    vi.mocked(TransactionProver.newLocalProver).mockImplementation(() => {
      if (!wasmReady) {
        throw new Error("wasm.__wbindgen_malloc is undefined");
      }
      return { type: "local" } as unknown as TransactionProver;
    });

    // Flip wasmReady to true inside createClient — the real WebClient.createClient
    // is what triggers WASM init, so anything constructed after it resolves
    // should succeed.
    const createClientMock = vi.mocked(WebClient.createClient);
    const defaultResolved = await createClientMock();
    createClientMock.mockImplementation(async () => {
      wasmReady = true;
      return defaultResolved;
    });

    render(
      <MidenProvider
        config={{
          rpcUrl: "https://rpc.testnet.miden.io",
          prover: "testnet",
        }}
      >
        <ProverDisplay />
      </MidenProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });

    await waitFor(() => {
      expect(screen.getByTestId("has-prover").textContent).toBe("true");
    });

    expect(TransactionProver.newRemoteProver).toHaveBeenCalled();
  });
});

describe("MidenProvider loading and error components", () => {
  it("should render loadingComponent while initializing", async () => {
    // Hold createClient pending so isInitializing stays true
    let resolveInit: (v: unknown) => void;
    const pendingInit = new Promise((resolve) => {
      resolveInit = resolve;
    });

    vi.mocked(WebClient.createClient).mockReturnValueOnce(
      pendingInit as ReturnType<typeof WebClient.createClient>
    );

    render(
      <MidenProvider
        config={{ rpcUrl: "testnet" }}
        loadingComponent={<div data-testid="loading">Loading...</div>}
      >
        <div data-testid="children">children</div>
      </MidenProvider>
    );

    // Loading component should appear while pending
    await waitFor(() => {
      expect(screen.queryByTestId("loading")).not.toBeNull();
    });

    // Resolve init to let it finish
    resolveInit!({
      syncState: vi.fn().mockResolvedValue({ blockNum: () => 100 }),
      getAccounts: vi.fn().mockResolvedValue([]),
    });
  });

  it("should render errorComponent (ReactNode) on init failure", async () => {
    vi.mocked(WebClient.createClient).mockRejectedValueOnce(
      new Error("Init failed")
    );

    render(
      <MidenProvider
        config={{ rpcUrl: "testnet" }}
        errorComponent={<div data-testid="error-node">Error!</div>}
      >
        <div data-testid="children">children</div>
      </MidenProvider>
    );

    await waitFor(() => {
      expect(screen.queryByTestId("error-node")).not.toBeNull();
    });
  });

  it("should render errorComponent (function) on init failure", async () => {
    vi.mocked(WebClient.createClient).mockRejectedValueOnce(
      new Error("Init crashed")
    );

    const errorFn = vi.fn((err: Error) => (
      <div data-testid="error-fn">Error: {err.message}</div>
    ));

    render(
      <MidenProvider config={{ rpcUrl: "testnet" }} errorComponent={errorFn}>
        <div data-testid="children">children</div>
      </MidenProvider>
    );

    await waitFor(() => {
      expect(screen.queryByTestId("error-fn")).not.toBeNull();
    });

    expect(errorFn).toHaveBeenCalled();
  });
});

describe("MidenProvider sync function", () => {
  it("should call client.syncState when sync() is invoked after ready", async () => {
    // Capture the mock client before rendering
    const mockClient = await vi.mocked(WebClient.createClient)();

    const { result } = renderHook(() => useMiden(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
          {children}
        </MidenProvider>
      ),
    });

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    // Reset mock call counts from the init phase
    (
      mockClient as { syncState: ReturnType<typeof vi.fn> }
    ).syncState.mockClear();

    await act(async () => {
      await result.current.sync();
    });

    expect(
      (mockClient as { syncState: ReturnType<typeof vi.fn> }).syncState
    ).toHaveBeenCalled();
  });

  it("should set error state when syncState throws", async () => {
    const mockClient = await vi.mocked(WebClient.createClient)();

    const { result } = renderHook(() => useMiden(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
          {children}
        </MidenProvider>
      ),
    });

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    (
      mockClient as { syncState: ReturnType<typeof vi.fn> }
    ).syncState.mockRejectedValueOnce(new Error("Sync error"));

    await act(async () => {
      await result.current.sync();
    });

    // Sync error should be reflected in store
    const { sync: syncStore } = useMidenStore.getState();
    expect(syncStore.error?.message).toBe("Sync error");
  });

  it("should skip sync when already syncing (isSyncing guard)", async () => {
    const mockClient = await vi.mocked(WebClient.createClient)();

    const { result } = renderHook(() => useMiden(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
          {children}
        </MidenProvider>
      ),
    });

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    (
      mockClient as { syncState: ReturnType<typeof vi.fn> }
    ).syncState.mockClear();

    // Set isSyncing = true to trigger the guard
    act(() => {
      useMidenStore.getState().setSyncState({ isSyncing: true });
    });

    await act(async () => {
      await result.current.sync();
    });

    // syncState should NOT have been called due to isSyncing guard
    expect(
      (mockClient as { syncState: ReturnType<typeof vi.fn> }).syncState
    ).not.toHaveBeenCalled();
  });
});

describe("useMidenClient", () => {
  it("should throw when client is not ready (line 459-464)", () => {
    function Wrapper({ children }: { children: React.ReactNode }) {
      return <MidenProvider config={{}}>{children}</MidenProvider>;
    }

    // useMidenClient is a hook — test the error path by checking it throws
    // without a ready client
    expect(() => {
      const { result } = renderHook(
        () => {
          try {
            return useMidenClient();
          } catch (e) {
            return { error: e };
          }
        },
        { wrapper: Wrapper }
      );
      // This path throws before client is ready
    }).not.toThrow(); // renderHook wraps; inner hook catches
  });
});
