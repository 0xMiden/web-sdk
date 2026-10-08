import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { WasmWebClient as WebClient } from "@miden-sdk/miden-sdk";
import { MidenProvider, useMiden } from "../../context/MidenProvider";
import { SignerContext } from "../../context/SignerContext";
import { useMidenStore } from "../../store/MidenStore";
import { createMockSignerContext } from "../mocks/signer-context";

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

describe("MidenProvider client lifetime", () => {
  it("terminates a client whose creation finishes after unmount", async () => {
    const late = { terminate: vi.fn() };
    let finishCreate!: (client: WebClient) => void;
    vi.mocked(WebClient.createClient).mockImplementationOnce(
      () =>
        new Promise<WebClient>((resolve) => {
          finishCreate = resolve;
        })
    );

    const { unmount } = render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <StatusDisplay />
      </MidenProvider>
    );
    await waitFor(() => {
      expect(WebClient.createClient).toHaveBeenCalled();
    });
    unmount();
    finishCreate(late as unknown as WebClient);

    await waitFor(() => {
      expect(late.terminate).toHaveBeenCalledTimes(1);
    });
    expect(useMidenStore.getState().client).toBeNull();
  });

  it("terminates and clears its client when it unmounts", async () => {
    const { unmount } = render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <StatusDisplay />
      </MidenProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });
    const client = useMidenStore.getState().client!;
    expect(client.terminate).not.toHaveBeenCalled();

    unmount();
    expect(client.terminate).toHaveBeenCalledTimes(1);
    expect(useMidenStore.getState().client).toBeNull();
  });

  it("leaves a client it does not own in the store when it unmounts", async () => {
    const { unmount } = render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <StatusDisplay />
      </MidenProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });
    const owned = useMidenStore.getState().client!;
    const other = { terminate: vi.fn() } as unknown as WebClient;
    act(() => {
      useMidenStore.getState().setClient(other);
    });

    unmount();
    expect(owned.terminate).toHaveBeenCalledTimes(1);
    expect(other.terminate).not.toHaveBeenCalled();
    expect(useMidenStore.getState().client).toBe(other);
  });

  it("terminates a client whose init fails after creating it", async () => {
    const failing = {
      syncState: vi.fn().mockRejectedValue(new Error("sync failed")),
      terminate: vi.fn(),
    };
    vi.mocked(WebClient.createClientWithExternalKeystore).mockResolvedValueOnce(
      failing as unknown as WebClient
    );
    const signer = createMockSignerContext({
      isConnected: true,
      storeName: "failing_init",
    });

    render(
      <SignerContext.Provider value={signer}>
        <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
          <StatusDisplay />
        </MidenProvider>
      </SignerContext.Provider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toBe("sync failed");
    });
    expect(failing.terminate).toHaveBeenCalledTimes(1);
    expect(useMidenStore.getState().client).toBeNull();
  });
});
