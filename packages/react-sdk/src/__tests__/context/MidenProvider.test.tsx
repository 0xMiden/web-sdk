import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  const config = { rpcUrl: "https://rpc.testnet.miden.io" };

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

  it("leaves the client it handed out alive when it unmounts", async () => {
    const { unmount } = render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <StatusDisplay />
      </MidenProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });
    const client = useMidenStore.getState().client!;

    unmount();
    expect(client.terminate).not.toHaveBeenCalled();
    expect(useMidenStore.getState().client).toBe(client);
  });

  it("leaves the client it replaces on an identity change alive", async () => {
    const base = await (
      WebClient.createClientWithExternalKeystore as ReturnType<typeof vi.fn>
    )();
    const firstClient = { ...base, terminate: vi.fn() } as unknown as WebClient;
    const secondClient = {
      ...base,
      terminate: vi.fn(),
    } as unknown as WebClient;
    vi.mocked(WebClient.createClientWithExternalKeystore)
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const Tree = ({ storeName }: { storeName: string }) => (
      <SignerContext.Provider
        value={createMockSignerContext({ isConnected: true, storeName })}
      >
        <MidenProvider config={config}>
          <StatusDisplay />
        </MidenProvider>
      </SignerContext.Provider>
    );

    const { rerender } = render(<Tree storeName="wallet_A" />);
    await waitFor(() => {
      expect(useMidenStore.getState().client).toBe(firstClient);
    });
    rerender(<Tree storeName="wallet_B" />);
    await waitFor(() => {
      expect(useMidenStore.getState().client).toBe(secondClient);
    });

    expect(firstClient.terminate).not.toHaveBeenCalled();
    expect(secondClient.terminate).not.toHaveBeenCalled();
  });

  it("leaves the client it replaces on a re-init alive", async () => {
    const { rerender } = render(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <StatusDisplay />
      </MidenProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });
    const firstClient = useMidenStore.getState().client!;
    const secondClient = {
      ...firstClient,
      terminate: vi.fn(),
    } as unknown as WebClient;
    vi.mocked(WebClient.createClient).mockResolvedValueOnce(secondClient);

    rerender(
      <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
        <StatusDisplay />
      </MidenProvider>
    );
    await waitFor(() => {
      expect(useMidenStore.getState().client).toBe(secondClient);
    });

    expect(firstClient.terminate).not.toHaveBeenCalled();
    expect(secondClient.terminate).not.toHaveBeenCalled();
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
