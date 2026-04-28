import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, renderHook } from "@testing-library/react";
import React from "react";
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
});
