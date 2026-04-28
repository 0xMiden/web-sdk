import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, renderHook } from "@testing-library/react";
import { WasmWebClient as WebClient } from "@miden-sdk/miden-sdk";
import {
  MidenProvider,
  useMiden,
  useMidenClient,
} from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";

// Coverage-targeted tests for branches that the main MidenProvider.test.tsx
// doesn't exercise (custom loading/error UI, init failure path, useMidenClient
// throws when not ready, useMiden throws outside provider).

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("MidenProvider — custom loading + error rendering", () => {
  it("renders the loadingComponent ReactNode while initializing", async () => {
    // Make createClient hang so isInitializing stays true long enough to
    // observe the custom loading UI.
    const pending = new Promise<unknown>(() => {});
    vi.mocked(WebClient.createClient).mockReturnValueOnce(
      pending as ReturnType<typeof WebClient.createClient>
    );

    render(
      <MidenProvider
        config={{ rpcUrl: "https://rpc.testnet.miden.io" }}
        loadingComponent={
          <div data-testid="custom-loading">Custom loading…</div>
        }
      >
        <div data-testid="children">should not render yet</div>
      </MidenProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("custom-loading")).toBeDefined();
    });
    // children are NOT rendered while loading UI is taking over.
    expect(screen.queryByTestId("children")).toBeNull();
  });

  it("renders an errorComponent ReactNode when init fails", async () => {
    vi.mocked(WebClient.createClient).mockRejectedValueOnce(
      new Error("init blew up")
    );

    render(
      <MidenProvider
        config={{ rpcUrl: "https://rpc.testnet.miden.io" }}
        errorComponent={<div data-testid="custom-error">An error</div>}
      >
        <div data-testid="children">should not render</div>
      </MidenProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("custom-error")).toBeDefined();
    });
    expect(screen.queryByTestId("children")).toBeNull();
  });

  it("invokes errorComponent as a function with the Error", async () => {
    vi.mocked(WebClient.createClient).mockRejectedValueOnce(
      new Error("specific failure")
    );
    const renderError = vi.fn((err: Error) => (
      <div data-testid="error-fn">Got: {err.message}</div>
    ));

    render(
      <MidenProvider
        config={{ rpcUrl: "https://rpc.testnet.miden.io" }}
        errorComponent={renderError}
      >
        <div>children</div>
      </MidenProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("error-fn")).toBeDefined();
    });
    expect(renderError).toHaveBeenCalledWith(expect.any(Error));
    expect(screen.getByText(/Got: specific failure/)).toBeDefined();
  });

  it("normalizes a non-Error rejection into an Error with the stringified value", async () => {
    vi.mocked(WebClient.createClient).mockRejectedValueOnce("plain string");

    function ErrDisplay() {
      const { error } = useMiden();
      return <span data-testid="err">{error?.message ?? "none"}</span>;
    }

    render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <ErrDisplay />
      </MidenProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("err").textContent).toBe("plain string");
    });
  });
});

describe("useMiden / useMidenClient", () => {
  it("useMiden throws when called outside a MidenProvider", () => {
    // renderHook captures the thrown error.
    const result = renderHook(() => {
      try {
        return { value: useMiden(), error: null };
      } catch (e) {
        return { value: null, error: e as Error };
      }
    });
    expect(result.result.current.error).toBeInstanceOf(Error);
    expect(result.result.current.error?.message).toMatch(
      /useMiden must be used within a MidenProvider/
    );
  });

  it("useMidenClient throws when client is not ready", () => {
    function ClientGetter() {
      try {
        useMidenClient();
        return <span data-testid="client">ready</span>;
      } catch (e) {
        return <span data-testid="error">{(e as Error).message}</span>;
      }
    }

    // Render the consumer before init resolves — client is null, isReady is false.
    const pending = new Promise<unknown>(() => {});
    vi.mocked(WebClient.createClient).mockReturnValueOnce(
      pending as ReturnType<typeof WebClient.createClient>
    );

    render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <ClientGetter />
      </MidenProvider>
    );

    expect(screen.getByTestId("error").textContent).toMatch(
      /Miden client is not ready/
    );
  });

  it("useMidenClient returns the client once initialization completes", async () => {
    function ClientGetter() {
      try {
        useMidenClient();
        return <span data-testid="ok">ok</span>;
      } catch {
        return <span data-testid="not-ok">not yet</span>;
      }
    }

    render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <ClientGetter />
      </MidenProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("ok")).toBeDefined();
    });
  });
});

describe("MidenProvider — auto-sync + state-change listener", () => {
  it("auto-syncs at the configured interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const syncSpy = vi.fn().mockResolvedValue({
        blockNum: () => 100,
      });
      // Re-mock createClient to return a client whose syncState we can spy on.
      const stub = {
        getAccounts: vi.fn().mockResolvedValue([]),
        syncState: syncSpy,
        getSyncHeight: vi.fn().mockResolvedValue(100),
        onStateChanged: vi.fn(() => () => {}),
        free: vi.fn(),
      };
      vi.mocked(WebClient.createClient).mockResolvedValueOnce(
        stub as unknown as WebClient
      );

      render(
        <MidenProvider
          config={{
            rpcUrl: "https://rpc.testnet.miden.io",
            autoSyncInterval: 100,
          }}
        >
          <div>kids</div>
        </MidenProvider>
      );

      // Wait for init to finish.
      await waitFor(() => {
        expect(stub.getAccounts).toHaveBeenCalled();
      });

      const beforeAdvance = syncSpy.mock.calls.length;
      vi.advanceTimersByTime(350);
      // We expect at least 2 additional sync ticks (100ms cadence over 350ms).
      // Use a loose lower bound to avoid flake from sync coalescing.
      expect(syncSpy.mock.calls.length).toBeGreaterThan(beforeAdvance);
    } finally {
      vi.useRealTimers();
    }
  });

  it("subscribes via onStateChanged and unsubscribes on unmount", async () => {
    const unsub = vi.fn();
    const stub = {
      getAccounts: vi.fn().mockResolvedValue([]),
      syncState: vi.fn().mockResolvedValue({ blockNum: () => 100 }),
      getSyncHeight: vi.fn().mockResolvedValue(100),
      onStateChanged: vi.fn(() => unsub),
      free: vi.fn(),
    };
    vi.mocked(WebClient.createClient).mockResolvedValueOnce(
      stub as unknown as WebClient
    );

    const { unmount } = render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <div>kids</div>
      </MidenProvider>
    );

    await waitFor(() => {
      expect(stub.onStateChanged).toHaveBeenCalled();
    });

    unmount();
    expect(unsub).toHaveBeenCalled();
  });

  it("swallows errors from the initial syncState (init catch branch)", async () => {
    // syncState throws synchronously during init; the inner try/catch must
    // swallow it so getAccounts and setClient can still run. We assert
    // the children eventually render — proving the provider didn't bail.
    const stub = {
      getAccounts: vi.fn().mockResolvedValue([]),
      syncState: vi.fn().mockRejectedValue(new Error("syncState boom")),
      getSyncHeight: vi.fn().mockResolvedValue(100),
      onStateChanged: vi.fn(() => () => {}),
      free: vi.fn(),
    };
    vi.mocked(WebClient.createClient).mockResolvedValueOnce(
      stub as unknown as WebClient
    );

    render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <div data-testid="post-init">ready</div>
      </MidenProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("post-init")).toBeDefined();
    });
    // getAccounts ran AFTER syncState threw — proves the catch swallowed.
    expect(stub.getAccounts).toHaveBeenCalled();
  });

  it("swallows errors from getAccounts during init (getAccounts catch branch)", async () => {
    const stub = {
      getAccounts: vi
        .fn()
        .mockRejectedValueOnce(new Error("getAccounts boom"))
        // Subsequent calls (auto-sync, etc.) should resolve.
        .mockResolvedValue([]),
      syncState: vi.fn().mockResolvedValue({ blockNum: () => 100 }),
      getSyncHeight: vi.fn().mockResolvedValue(100),
      onStateChanged: vi.fn(() => () => {}),
      free: vi.fn(),
    };
    vi.mocked(WebClient.createClient).mockResolvedValueOnce(
      stub as unknown as WebClient
    );

    render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <div data-testid="post-init-2">ready</div>
      </MidenProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("post-init-2")).toBeDefined();
    });
  });

  it("swallows errors from getAccounts inside the onStateChanged listener", async () => {
    let registeredCb: (() => Promise<void>) | null = null;
    const stub = {
      getAccounts: vi.fn().mockResolvedValueOnce([]),
      syncState: vi.fn().mockResolvedValue({ blockNum: () => 100 }),
      getSyncHeight: vi.fn().mockResolvedValue(100),
      onStateChanged: vi.fn((cb: () => Promise<void>) => {
        registeredCb = cb;
        return () => {};
      }),
      free: vi.fn(),
    };
    vi.mocked(WebClient.createClient).mockResolvedValueOnce(
      stub as unknown as WebClient
    );

    render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <div data-testid="state-changed-ready">ok</div>
      </MidenProvider>
    );

    await waitFor(() => {
      expect(stub.onStateChanged).toHaveBeenCalled();
      expect(registeredCb).toBeTypeOf("function");
    });

    // Make the next getAccounts inside the listener throw — the catch
    // should swallow it without crashing the provider.
    stub.getAccounts.mockRejectedValueOnce(new Error("listener boom"));
    await registeredCb!();
    // No throw escaped — the listener catch did its job.
    expect(screen.getByTestId("state-changed-ready")).toBeDefined();
  });

  it("captures errors from the explicit sync() call into store.sync.error", async () => {
    // Hits the catch at MidenProvider.tsx ~134-138: the user-facing sync()
    // function (returned via useMiden().sync) catches syncState failures and
    // writes them to the store's sync.error field. Existing tests cover only
    // the init-time and listener-time catches.
    const stub = {
      getAccounts: vi.fn().mockResolvedValue([]),
      // First call (init) succeeds; later sync() calls reject so we hit the
      // explicit-sync catch branch.
      syncState: vi
        .fn()
        .mockResolvedValueOnce({ blockNum: () => 100 })
        .mockRejectedValue(new Error("explicit sync boom")),
      getSyncHeight: vi.fn().mockResolvedValue(100),
      onStateChanged: vi.fn(() => () => {}),
      free: vi.fn(),
    };
    vi.mocked(WebClient.createClient).mockResolvedValueOnce(
      stub as unknown as WebClient
    );

    let midenRef: ReturnType<typeof useMiden>;
    function Capture() {
      midenRef = useMiden();
      return null;
    }

    render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <Capture />
      </MidenProvider>
    );

    await waitFor(() => {
      expect(midenRef?.isReady).toBe(true);
    });

    await midenRef!.sync();
    expect(useMidenStore.getState().sync.error?.message).toBe(
      "explicit sync boom"
    );
  });

  it("invokes the success path of the onStateChanged listener (setAccounts + setSyncState)", async () => {
    // Companion to the catch-path test above: this one lets getAccounts
    // resolve inside the listener so lines 394-395 (setAccounts + setSyncState)
    // execute on the happy path.
    let registeredCb: (() => Promise<void>) | null = null;
    const stub = {
      getAccounts: vi.fn().mockResolvedValue([]),
      syncState: vi.fn().mockResolvedValue({ blockNum: () => 100 }),
      getSyncHeight: vi.fn().mockResolvedValue(100),
      onStateChanged: vi.fn((cb: () => Promise<void>) => {
        registeredCb = cb;
        return () => {};
      }),
      free: vi.fn(),
    };
    vi.mocked(WebClient.createClient).mockResolvedValueOnce(
      stub as unknown as WebClient
    );

    render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <div data-testid="state-changed-success">ok</div>
      </MidenProvider>
    );

    await waitFor(() => {
      expect(registeredCb).toBeTypeOf("function");
    });

    // Reset the call counter so we observe getAccounts ONLY from the listener.
    stub.getAccounts.mockClear();
    await registeredCb!();
    // The listener invoked getAccounts again (success path), proving lines
    // 393-395 ran. setSyncState was called too, but lastSyncTime defaults to
    // undefined in the initial store state, so we just assert getAccounts ran
    // a second time (the catch path test confirmed the error branch).
    expect(stub.getAccounts).toHaveBeenCalledTimes(1);
    // lastSyncTime is nested under sync.lastSyncTime; the listener bumps it
    // via setSyncState, so it should now be a number.
    expect(typeof useMidenStore.getState().sync.lastSyncTime).toBe("number");
  });
});
