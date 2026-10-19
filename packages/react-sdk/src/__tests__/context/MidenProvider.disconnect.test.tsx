import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  renderHook,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import React from "react";
import { WasmWebClient as WebClient } from "@miden-sdk/miden-sdk";
import type {
  Account,
  AccountHeader,
  InputNoteRecord,
} from "@miden-sdk/miden-sdk";
import { MidenProvider, useMiden } from "../../context/MidenProvider";
import { useImportAccount } from "../../hooks/useImportAccount";
import { SignerContext } from "../../context/SignerContext";
import type { SignerContextValue } from "../../context/SignerContext";
import type { MidenConfig } from "../../types";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockSignerAccountConfig,
  createMockSignerContext,
  createDisconnectedSignerContext,
} from "../mocks/signer-context";
import {
  createMockAccount,
  createMockAccountHeader,
  createMockInputNoteRecord,
  createMockSyncSummary,
  createMockWebClient,
} from "../mocks/miden-sdk";

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

function StatusDisplay() {
  const { isReady, isInitializing, error, signerConnected, signerAccountId } =
    useMiden();
  return (
    <div>
      <span data-testid="ready">{String(isReady)}</span>
      <span data-testid="initializing">{String(isInitializing)}</span>
      <span data-testid="error">{error?.message ?? "none"}</span>
      <span data-testid="signer-connected">{String(signerConnected)}</span>
      <span data-testid="signer-account">{signerAccountId ?? "none"}</span>
    </div>
  );
}

const identityConfig: MidenConfig = {
  rpcUrl: "https://rpc.testnet.miden.io",
  autoSyncInterval: 0,
};

function IdentityWrapper({
  signer,
  config = identityConfig,
  children,
}: {
  signer: SignerContextValue | null;
  config?: MidenConfig;
  children: React.ReactNode;
}) {
  return (
    <SignerContext.Provider value={signer}>
      <MidenProvider config={config}>{children}</MidenProvider>
    </SignerContext.Provider>
  );
}

function ImportDisplay() {
  const { importAccount, account, error } = useImportAccount();
  return (
    <div>
      <button
        onClick={() => {
          void importAccount({ type: "id", accountId: "0x1234" }).catch(
            () => {}
          );
        }}
      >
        Import account
      </button>
      <span data-testid="imported-account">
        {account?.id().toString() ?? "none"}
      </span>
      <span data-testid="import-error">{error?.message ?? "none"}</span>
    </div>
  );
}

describe("MidenProvider resilient disconnect handling", () => {
  describe("disconnect does not destroy client", () => {
    it("sets signerConnected=false on disconnect without resetting client", async () => {
      // Start connected
      const connectedSigner = createMockSignerContext({
        isConnected: true,
        storeName: "test_wallet",
      });

      const Wrapper = ({
        signer,
        children,
      }: {
        signer: SignerContextValue;
        children: React.ReactNode;
      }) => (
        <SignerContext.Provider value={signer}>
          <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
            {children}
          </MidenProvider>
        </SignerContext.Provider>
      );

      const { rerender } = render(
        <Wrapper signer={connectedSigner}>
          <StatusDisplay />
        </Wrapper>
      );

      // Wait for init
      await waitFor(() => {
        expect(screen.getByTestId("ready").textContent).toBe("true");
      });

      expect(screen.getByTestId("signer-connected").textContent).toBe("true");

      // Verify client was created
      expect(WebClient.createClientWithExternalKeystore).toHaveBeenCalled();
      const createCallCount = (
        WebClient.createClientWithExternalKeystore as ReturnType<typeof vi.fn>
      ).mock.calls.length;

      // Now disconnect
      const disconnectedSigner = createDisconnectedSignerContext({
        storeName: "test_wallet",
      });

      rerender(
        <Wrapper signer={disconnectedSigner}>
          <StatusDisplay />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("signer-connected").textContent).toBe(
          "false"
        );
      });

      // Client should still be ready (not destroyed)
      expect(screen.getByTestId("ready").textContent).toBe("true");
      expect(useMidenStore.getState().client!.terminate).not.toHaveBeenCalled();

      // No new client was created
      expect(
        (WebClient.createClientWithExternalKeystore as ReturnType<typeof vi.fn>)
          .mock.calls.length
      ).toBe(createCallCount);
    });

    it("preserves cached accounts and notes during disconnect", async () => {
      const connectedSigner = createMockSignerContext({
        isConnected: true,
        storeName: "test_wallet",
      });

      const Wrapper = ({
        signer,
        children,
      }: {
        signer: SignerContextValue;
        children: React.ReactNode;
      }) => (
        <SignerContext.Provider value={signer}>
          <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
            {children}
          </MidenProvider>
        </SignerContext.Provider>
      );

      render(
        <Wrapper signer={connectedSigner}>
          <StatusDisplay />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("ready").textContent).toBe("true");
      });

      // Simulate some cached state
      const store = useMidenStore.getState();
      expect(store.client).not.toBeNull();

      // Disconnect - cached state should NOT be cleared
      // Simulate disconnect by setting signerConnected=false directly
      // (in real usage, MidenProvider effect does this)
      act(() => {
        useMidenStore.getState().setSignerConnected(false);
      });

      const storeAfter = useMidenStore.getState();
      expect(storeAfter.client).not.toBeNull();
      expect(storeAfter.isReady).toBe(true);
      expect(storeAfter.signerConnected).toBe(false);
    });
  });

  describe("reconnect with same storeName reuses client", () => {
    it("hot-swaps signCb without creating a new client", async () => {
      const signCb1 = vi.fn().mockResolvedValue(new Uint8Array(67));
      const connectedSigner = createMockSignerContext({
        isConnected: true,
        storeName: "test_wallet",
        signCb: signCb1,
      });

      const Wrapper = ({
        signer,
        children,
      }: {
        signer: SignerContextValue;
        children: React.ReactNode;
      }) => (
        <SignerContext.Provider value={signer}>
          <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
            {children}
          </MidenProvider>
        </SignerContext.Provider>
      );

      const { rerender } = render(
        <Wrapper signer={connectedSigner}>
          <StatusDisplay />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("ready").textContent).toBe("true");
      });

      const initialCreateCount = (
        WebClient.createClientWithExternalKeystore as ReturnType<typeof vi.fn>
      ).mock.calls.length;

      // Disconnect
      const disconnectedSigner = createDisconnectedSignerContext({
        storeName: "test_wallet",
      });

      rerender(
        <Wrapper signer={disconnectedSigner}>
          <StatusDisplay />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("signer-connected").textContent).toBe(
          "false"
        );
      });

      // Reconnect with new signCb, same storeName
      const signCb2 = vi.fn().mockResolvedValue(new Uint8Array(67));
      const reconnectedSigner = createMockSignerContext({
        isConnected: true,
        storeName: "test_wallet",
        signCb: signCb2,
      });

      rerender(
        <Wrapper signer={reconnectedSigner}>
          <StatusDisplay />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("signer-connected").textContent).toBe("true");
      });

      // No additional client was created - signCb was hot-swapped
      expect(
        (WebClient.createClientWithExternalKeystore as ReturnType<typeof vi.fn>)
          .mock.calls.length
      ).toBe(initialCreateCount);
      expect(useMidenStore.getState().client!.terminate).not.toHaveBeenCalled();

      // Verify the wrapped callback passed to the client invokes the latest signCb (signCb2)
      const passedSignCb = (
        WebClient.createClientWithExternalKeystore as ReturnType<typeof vi.fn>
      ).mock.calls[0][6];
      await passedSignCb(new Uint8Array(32), new Uint8Array(32));
      expect(signCb2).toHaveBeenCalledTimes(1);
    });

    it("rebuilds external keystore client when reconnecting signer after local keystore mode", async () => {
      const connectedSigner = createMockSignerContext({
        isConnected: true,
        storeName: "test_wallet",
      });

      const Wrapper = ({
        signer,
        children,
      }: {
        signer: SignerContextValue | null;
        children: React.ReactNode;
      }) => (
        <SignerContext.Provider value={signer}>
          <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
            {children}
          </MidenProvider>
        </SignerContext.Provider>
      );

      const { rerender } = render(
        <Wrapper signer={connectedSigner}>
          <StatusDisplay />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("ready").textContent).toBe("true");
      });
      expect(screen.getByTestId("signer-connected").textContent).toBe("true");

      const externalKeystoreCallsBefore = (
        WebClient.createClientWithExternalKeystore as ReturnType<typeof vi.fn>
      ).mock.calls.length;

      // Switch to local keystore mode (signerContext becomes null)
      rerender(
        <Wrapper signer={null}>
          <StatusDisplay />
        </Wrapper>
      );

      await waitFor(() => {
        expect(WebClient.createClient).toHaveBeenCalled();
      });

      // Now reconnect the same signer storeName
      rerender(
        <Wrapper signer={connectedSigner}>
          <StatusDisplay />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("signer-connected").textContent).toBe("true");
      });

      // A local client has no signer identity and cannot satisfy a signer reconnect.
      expect(
        (WebClient.createClientWithExternalKeystore as ReturnType<typeof vi.fn>)
          .mock.calls.length
      ).toBeGreaterThan(externalKeystoreCallsBefore);
    });
  });

  describe("local and signer identity transitions", () => {
    it("clears signer A's caches before signer B commits after local mode", async () => {
      const clientA = createMockWebClient();
      const localClient = createMockWebClient();
      const clientB = createMockWebClient();
      vi.mocked(WebClient.createClientWithExternalKeystore)
        .mockResolvedValueOnce(clientA as unknown as WebClient)
        .mockResolvedValueOnce(clientB as unknown as WebClient);
      vi.mocked(WebClient.createClient).mockResolvedValueOnce(
        localClient as unknown as WebClient
      );
      const signerA = createMockSignerContext({ storeName: "wallet_A" });
      const signerB = createMockSignerContext({ storeName: "wallet_B" });
      const cachedAccount = createMockAccount() as unknown as Account;
      const cachedHeader = createMockAccountHeader();
      const cachedNote = createMockInputNoteRecord("0xnote_A");

      const { rerender } = render(
        <IdentityWrapper signer={signerA}>
          <StatusDisplay />
        </IdentityWrapper>
      );
      await waitFor(() => {
        expect(useMidenStore.getState().client).toBe(clientA);
      });

      act(() => {
        const store = useMidenStore.getState();
        store.setAccounts([cachedHeader] as unknown as AccountHeader[]);
        store.setAccountDetails("0xaccount_A", cachedAccount);
        store.setNotes([cachedNote] as unknown as InputNoteRecord[], "all");
      });
      expect(useMidenStore.getState().accounts).toEqual([cachedHeader]);
      expect(useMidenStore.getState().accountDetails.size).toBe(1);
      expect(useMidenStore.getState().notesByFilter.get("all")).toEqual([
        cachedNote,
      ]);
      const generationA = useMidenStore.getState().cacheGeneration;

      rerender(
        <IdentityWrapper signer={null}>
          <StatusDisplay />
        </IdentityWrapper>
      );
      await waitFor(() => {
        expect(useMidenStore.getState().client).toBe(localClient);
      });
      const localGeneration = useMidenStore.getState().cacheGeneration;

      rerender(
        <IdentityWrapper signer={signerB}>
          <StatusDisplay />
        </IdentityWrapper>
      );
      await waitFor(() => {
        expect(useMidenStore.getState().client).toBe(clientB);
      });

      const store = useMidenStore.getState();
      expect(localGeneration).toBeGreaterThan(generationA);
      expect(store.cacheGeneration).toBeGreaterThan(localGeneration);
      expect(store.accounts).toEqual([]);
      expect(store.accountDetails.size).toBe(0);
      expect(store.notesByFilter.size).toBe(0);
      expect(store.noteFirstSeen.size).toBe(0);
      expect(store.signerConnected).toBe(true);
      expect(clientA.terminate).not.toHaveBeenCalled();
      expect(localClient.terminate).not.toHaveBeenCalled();
      expect(clientB.terminate).not.toHaveBeenCalled();
    });

    it("commits an external client after config cancels a pending signer initialization", async () => {
      const localClient = createMockWebClient();
      let finishAccounts!: (accounts: []) => void;
      const pendingAccounts = new Promise<[]>((resolve) => {
        finishAccounts = resolve;
      });
      const pendingClient = createMockWebClient({
        getAccounts: vi.fn().mockReturnValue(pendingAccounts),
      });
      const committedClient = createMockWebClient();
      vi.mocked(WebClient.createClient).mockResolvedValueOnce(
        localClient as unknown as WebClient
      );
      vi.mocked(WebClient.createClientWithExternalKeystore)
        .mockResolvedValueOnce(pendingClient as unknown as WebClient)
        .mockResolvedValueOnce(committedClient as unknown as WebClient);
      const signer = createMockSignerContext({
        storeName: "wallet_A",
        accountConfig: createMockSignerAccountConfig({
          importAccountId: "0x1234",
        }),
      });

      const { rerender } = render(
        <IdentityWrapper signer={null}>
          <StatusDisplay />
        </IdentityWrapper>
      );
      await waitFor(() => {
        expect(useMidenStore.getState().client).toBe(localClient);
      });

      rerender(
        <IdentityWrapper signer={signer}>
          <StatusDisplay />
        </IdentityWrapper>
      );
      await waitFor(() => {
        expect(pendingClient.getAccounts).toHaveBeenCalledTimes(1);
      });
      const pendingAccountId = screen.getByTestId("signer-account").textContent;

      rerender(
        <IdentityWrapper signer={signer} config={{ ...identityConfig }}>
          <StatusDisplay />
        </IdentityWrapper>
      );
      await act(async () => {
        finishAccounts([]);
        await pendingAccounts;
      });
      await waitFor(() => {
        expect(useMidenStore.getState().client).toBe(committedClient);
      });

      expect(useMidenStore.getState().signerConnected).toBe(true);
      expect(pendingAccountId).toBe("none");
      expect(screen.getByTestId("signer-account").textContent).toBe("0x1234");
      expect(pendingClient.terminate).toHaveBeenCalledTimes(1);
      expect(localClient.terminate).not.toHaveBeenCalled();
      expect(committedClient.terminate).not.toHaveBeenCalled();
    });

    it.each([true, false])(
      "clears signer state and permits local imports after signer connected=%s",
      async (isConnected) => {
        const signerClient = createMockWebClient();
        const importedAccount = createMockAccount();
        const localClient = createMockWebClient({
          getAccount: vi.fn().mockResolvedValue(importedAccount),
        });
        vi.mocked(
          WebClient.createClientWithExternalKeystore
        ).mockResolvedValueOnce(signerClient as unknown as WebClient);
        vi.mocked(WebClient.createClient).mockResolvedValueOnce(
          localClient as unknown as WebClient
        );
        const signer = createMockSignerContext({ storeName: "wallet_A" });
        const { rerender } = render(
          <IdentityWrapper signer={signer}>
            <StatusDisplay />
            <ImportDisplay />
          </IdentityWrapper>
        );
        await waitFor(() => {
          expect(useMidenStore.getState().client).toBe(signerClient);
        });
        expect(useMidenStore.getState().signerConnected).toBe(true);

        rerender(
          <IdentityWrapper signer={{ ...signer, isConnected }}>
            <StatusDisplay />
            <ImportDisplay />
          </IdentityWrapper>
        );
        await waitFor(() => {
          expect(useMidenStore.getState().signerConnected).toBe(isConnected);
        });

        rerender(
          <IdentityWrapper signer={null}>
            <StatusDisplay />
            <ImportDisplay />
          </IdentityWrapper>
        );
        await waitFor(() => {
          expect(useMidenStore.getState().client).toBe(localClient);
        });
        expect(useMidenStore.getState().signerConnected).toBeNull();
        expect(screen.getByTestId("signer-connected").textContent).toBe("null");
        expect(screen.getByTestId("signer-account").textContent).toBe("none");

        act(() => {
          screen.getByRole("button", { name: "Import account" }).click();
        });
        await waitFor(() => {
          expect(screen.getByTestId("imported-account").textContent).toBe(
            importedAccount.id().toString()
          );
        });
        expect(screen.getByTestId("import-error").textContent).toBe("none");
        expect(localClient.importAccountById).toHaveBeenCalledTimes(1);
        expect(signerClient.terminate).not.toHaveBeenCalled();
        expect(localClient.terminate).not.toHaveBeenCalled();
      }
    );
  });

  describe("connect with different storeName creates new client", () => {
    it("creates new client for different identity", async () => {
      const signer1 = createMockSignerContext({
        isConnected: true,
        storeName: "wallet_A",
      });

      const Wrapper = ({
        signer,
        children,
      }: {
        signer: SignerContextValue;
        children: React.ReactNode;
      }) => (
        <SignerContext.Provider value={signer}>
          <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
            {children}
          </MidenProvider>
        </SignerContext.Provider>
      );

      const { rerender } = render(
        <Wrapper signer={signer1}>
          <StatusDisplay />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("ready").textContent).toBe("true");
      });

      const firstCreateCount = (
        WebClient.createClientWithExternalKeystore as ReturnType<typeof vi.fn>
      ).mock.calls.length;
      const firstClient = useMidenStore.getState().client!;
      const secondClient = {
        ...firstClient,
        terminate: vi.fn(),
      } as unknown as WebClient;
      let finishSecond!: (client: WebClient) => void;
      vi.mocked(
        WebClient.createClientWithExternalKeystore
      ).mockImplementationOnce(
        () =>
          new Promise<WebClient>((resolve) => {
            finishSecond = resolve;
          })
      );

      // Connect with different identity
      const signer2 = createMockSignerContext({
        isConnected: true,
        storeName: "wallet_B",
      });

      rerender(
        <Wrapper signer={signer2}>
          <StatusDisplay />
        </Wrapper>
      );

      // Should eventually create a new client
      await waitFor(() => {
        expect(
          (
            WebClient.createClientWithExternalKeystore as ReturnType<
              typeof vi.fn
            >
          ).mock.calls.length
        ).toBeGreaterThan(firstCreateCount);
      });
      // The identity change clears the store but leaves the first client
      // alive: a hook flow that captured it may still be running.
      expect(firstClient.terminate).not.toHaveBeenCalled();
      expect(useMidenStore.getState().client).toBeNull();

      finishSecond(secondClient);
      await waitFor(() => {
        expect(useMidenStore.getState().client).toBe(secondClient);
      });
      expect(firstClient.terminate).not.toHaveBeenCalled();
      expect(secondClient.terminate).not.toHaveBeenCalled();
    });
  });

  describe("signerConnected exposed in context", () => {
    it("is null when no signer provider", async () => {
      render(
        <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
          <StatusDisplay />
        </MidenProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId("ready").textContent).toBe("true");
      });

      expect(screen.getByTestId("signer-connected").textContent).toBe("null");
    });

    it("is true when signer is connected and initialized", async () => {
      const signer = createMockSignerContext({
        isConnected: true,
        storeName: "test",
      });

      render(
        <SignerContext.Provider value={signer}>
          <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
            <StatusDisplay />
          </MidenProvider>
        </SignerContext.Provider>
      );

      await waitFor(() => {
        expect(screen.getByTestId("signer-connected").textContent).toBe("true");
      });
    });

    it("is false when signer disconnects", async () => {
      const signer = createMockSignerContext({
        isConnected: true,
        storeName: "test",
      });

      const Wrapper = ({
        signerValue,
        children,
      }: {
        signerValue: SignerContextValue;
        children: React.ReactNode;
      }) => (
        <SignerContext.Provider value={signerValue}>
          <MidenProvider config={{ rpcUrl: "https://rpc.testnet.miden.io" }}>
            {children}
          </MidenProvider>
        </SignerContext.Provider>
      );

      const { rerender } = render(
        <Wrapper signerValue={signer}>
          <StatusDisplay />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("signer-connected").textContent).toBe("true");
      });

      // Disconnect
      const disconnected = createDisconnectedSignerContext({
        storeName: "test",
      });
      rerender(
        <Wrapper signerValue={disconnected}>
          <StatusDisplay />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("signer-connected").textContent).toBe(
          "false"
        );
      });
    });
  });
});

describe("MidenProvider cache generation guards", () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <IdentityWrapper signer={null}>{children}</IdentityWrapper>
  );

  it("ignores signer A's saved sync after switching to signer B", async () => {
    const clientA = createMockWebClient();
    const clientB = createMockWebClient();
    vi.mocked(WebClient.createClientWithExternalKeystore)
      .mockResolvedValueOnce(clientA as unknown as WebClient)
      .mockResolvedValueOnce(clientB as unknown as WebClient);
    const signerA = createMockSignerContext({ storeName: "wallet-a" });
    const signerB = createMockSignerContext({ storeName: "wallet-b" });
    let signer = signerA;
    const { result, rerender } = renderHook(() => useMiden(), {
      wrapper: ({ children }) => (
        <IdentityWrapper signer={signer}>{children}</IdentityWrapper>
      ),
    });
    await waitFor(() => {
      expect(result.current.client).toBe(clientA);
    });
    const syncA = result.current.sync;
    signer = signerB;
    rerender();
    await waitFor(() => {
      expect(result.current.client).toBe(clientB);
    });
    const accountsB = [createMockAccountHeader("0x2000000000000002")];
    act(() => {
      useMidenStore.getState().resetInMemoryState();
      useMidenStore
        .getState()
        .setAccounts(accountsB as unknown as AccountHeader[]);
    });
    clientA.syncState.mockClear();
    clientA.getAccounts.mockClear();

    let syncing!: Promise<void>;
    act(() => {
      syncing = syncA();
    });
    expect(useMidenStore.getState().sync.isSyncing).toBe(false);
    await act(async () => {
      await syncing;
    });
    expect(useMidenStore.getState().sync.lastSyncTime).toBeNull();
    expect(useMidenStore.getState().accounts).toBe(accountsB);
    expect(clientA.syncState).not.toHaveBeenCalled();
    expect(clientA.getAccounts).not.toHaveBeenCalled();
  });

  it("does not cache a sync summary after the cache generation changes", async () => {
    const mockClient = createMockWebClient();
    vi.mocked(WebClient.createClient).mockResolvedValueOnce(
      mockClient as unknown as WebClient
    );
    const { result } = renderHook(() => useMiden(), { wrapper });
    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    const summary = createMockSyncSummary(321);
    let finishSync!: (value: typeof summary) => void;
    const pendingSync = new Promise<typeof summary>((resolve) => {
      finishSync = resolve;
    });
    mockClient.syncState.mockReturnValueOnce(pendingSync);

    let syncing!: Promise<void>;
    act(() => {
      syncing = result.current.sync();
    });
    expect(mockClient.syncState).toHaveBeenCalledTimes(2);
    expect(useMidenStore.getState().sync.isSyncing).toBe(true);

    const generation = useMidenStore.getState().cacheGeneration;
    act(() => {
      useMidenStore.getState().resetInMemoryState();
    });
    expect(useMidenStore.getState().cacheGeneration).toBe(generation + 1);

    await act(async () => {
      finishSync(summary);
      await syncing;
    });

    expect(useMidenStore.getState().sync).toEqual({
      syncHeight: 0,
      lastSyncTime: null,
      isSyncing: false,
      error: null,
    });
    expect(useMidenStore.getState().accounts).toEqual([]);
  });

  it("does not cache a sync error after the cache generation changes", async () => {
    const mockClient = createMockWebClient();
    vi.mocked(WebClient.createClient).mockResolvedValueOnce(
      mockClient as unknown as WebClient
    );
    const { result } = renderHook(() => useMiden(), { wrapper });
    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    let failSync!: (error: Error) => void;
    const pendingSync = new Promise<ReturnType<typeof createMockSyncSummary>>(
      (_resolve, reject) => {
        failSync = reject;
      }
    );
    mockClient.syncState.mockReturnValueOnce(pendingSync);

    let syncing!: Promise<void>;
    act(() => {
      syncing = result.current.sync();
    });
    expect(mockClient.syncState).toHaveBeenCalledTimes(2);
    expect(useMidenStore.getState().sync.isSyncing).toBe(true);

    const generation = useMidenStore.getState().cacheGeneration;
    act(() => {
      useMidenStore.getState().resetInMemoryState();
    });
    expect(useMidenStore.getState().cacheGeneration).toBe(generation + 1);

    await act(async () => {
      failSync(new Error("stale sync failed"));
      await syncing;
    });

    expect(useMidenStore.getState().sync).toEqual({
      syncHeight: 0,
      lastSyncTime: null,
      isSyncing: false,
      error: null,
    });
  });

  it("does not cache post-sync accounts after the cache generation changes", async () => {
    const mockClient = createMockWebClient();
    vi.mocked(WebClient.createClient).mockResolvedValueOnce(
      mockClient as unknown as WebClient
    );
    const { result } = renderHook(() => useMiden(), { wrapper });
    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });

    const staleAccounts = [createMockAccountHeader()];
    let finishAccounts!: (accounts: typeof staleAccounts) => void;
    const pendingAccounts = new Promise<typeof staleAccounts>((resolve) => {
      finishAccounts = resolve;
    });
    mockClient.syncState.mockResolvedValueOnce(createMockSyncSummary(321));
    mockClient.getAccounts.mockReturnValueOnce(pendingAccounts);

    let syncing!: Promise<void>;
    act(() => {
      syncing = result.current.sync();
    });
    await waitFor(() => {
      expect(mockClient.getAccounts).toHaveBeenCalledTimes(2);
    });
    expect(useMidenStore.getState().sync.syncHeight).toBe(321);
    expect(useMidenStore.getState().sync.lastSyncTime).toEqual(
      expect.any(Number)
    );

    const generation = useMidenStore.getState().cacheGeneration;
    act(() => {
      useMidenStore.getState().resetInMemoryState();
    });
    expect(useMidenStore.getState().cacheGeneration).toBe(generation + 1);

    await act(async () => {
      finishAccounts(staleAccounts);
      await syncing;
    });

    expect(useMidenStore.getState().accounts).toEqual([]);
    expect(useMidenStore.getState().sync.syncHeight).toBe(0);
    expect(useMidenStore.getState().sync.lastSyncTime).toBeNull();
  });

  it("does not cache an initial sync summary after the cache generation changes", async () => {
    const summary = createMockSyncSummary(321);
    let finishSync!: (value: typeof summary) => void;
    const pendingSync = new Promise<typeof summary>((resolve) => {
      finishSync = resolve;
    });
    const mockClient = createMockWebClient({
      syncState: vi.fn().mockReturnValue(pendingSync),
    });
    vi.mocked(WebClient.createClient).mockResolvedValueOnce(
      mockClient as unknown as WebClient
    );
    render(
      <IdentityWrapper signer={null}>
        <StatusDisplay />
      </IdentityWrapper>
    );
    await waitFor(() => {
      expect(mockClient.syncState).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId("ready").textContent).toBe("false");

    const generation = useMidenStore.getState().cacheGeneration;
    act(() => {
      useMidenStore.getState().resetInMemoryState();
    });
    expect(useMidenStore.getState().cacheGeneration).toBe(generation + 1);

    await act(async () => {
      finishSync(summary);
      await pendingSync;
    });
    await waitFor(() => {
      expect(useMidenStore.getState().client).toBe(mockClient);
    });

    expect(screen.getByTestId("ready").textContent).toBe("true");
    expect(useMidenStore.getState().sync.syncHeight).toBe(0);
    expect(useMidenStore.getState().sync.lastSyncTime).toBeNull();
    expect(useMidenStore.getState().initError).toBeNull();
  });

  it("does not cache initial accounts after the cache generation changes", async () => {
    const staleAccounts = [createMockAccountHeader()];
    let finishAccounts!: (accounts: typeof staleAccounts) => void;
    const pendingAccounts = new Promise<typeof staleAccounts>((resolve) => {
      finishAccounts = resolve;
    });
    const mockClient = createMockWebClient({
      getAccounts: vi.fn().mockReturnValue(pendingAccounts),
    });
    vi.mocked(WebClient.createClient).mockResolvedValueOnce(
      mockClient as unknown as WebClient
    );
    render(
      <IdentityWrapper signer={null}>
        <StatusDisplay />
      </IdentityWrapper>
    );
    await waitFor(() => {
      expect(mockClient.getAccounts).toHaveBeenCalledTimes(1);
    });
    expect(useMidenStore.getState().sync.syncHeight).toBe(100);
    expect(screen.getByTestId("ready").textContent).toBe("false");

    const generation = useMidenStore.getState().cacheGeneration;
    act(() => {
      useMidenStore.getState().resetInMemoryState();
    });
    expect(useMidenStore.getState().cacheGeneration).toBe(generation + 1);

    await act(async () => {
      finishAccounts(staleAccounts);
      await pendingAccounts;
    });
    await waitFor(() => {
      expect(useMidenStore.getState().client).toBe(mockClient);
    });

    expect(screen.getByTestId("ready").textContent).toBe("true");
    expect(useMidenStore.getState().accounts).toEqual([]);
    expect(useMidenStore.getState().sync.syncHeight).toBe(0);
    expect(useMidenStore.getState().sync.lastSyncTime).toBeNull();
    expect(useMidenStore.getState().initError).toBeNull();
  });

  it("caches a cross-tab refresh while the cache generation is unchanged", async () => {
    let notifyStateChanged!: () => Promise<void>;
    const mockClient = {
      ...createMockWebClient(),
      onStateChanged: vi.fn((listener: () => Promise<void>) => {
        notifyStateChanged = listener;
        return vi.fn();
      }),
    };
    vi.mocked(WebClient.createClient).mockResolvedValueOnce(
      mockClient as unknown as WebClient
    );
    const { result } = renderHook(() => useMiden(), { wrapper });
    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
      expect(mockClient.onStateChanged).toHaveBeenCalledTimes(1);
    });

    const freshAccounts = [createMockAccountHeader()];
    mockClient.getAccounts.mockResolvedValueOnce(freshAccounts);
    await act(async () => {
      await notifyStateChanged();
    });

    expect(useMidenStore.getState().accounts).toBe(freshAccounts);
    expect(useMidenStore.getState().sync.lastSyncTime).not.toBeNull();
  });

  it("does not cache a cross-tab refresh after the cache generation changes", async () => {
    let notifyStateChanged!: () => Promise<void>;
    const mockClient = {
      ...createMockWebClient(),
      onStateChanged: vi.fn((listener: () => Promise<void>) => {
        notifyStateChanged = listener;
        return vi.fn();
      }),
    };
    vi.mocked(WebClient.createClient).mockResolvedValueOnce(
      mockClient as unknown as WebClient
    );
    const { result } = renderHook(() => useMiden(), { wrapper });
    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
      expect(mockClient.onStateChanged).toHaveBeenCalledTimes(1);
    });

    const staleAccounts = [createMockAccountHeader()];
    let finishAccounts!: (accounts: typeof staleAccounts) => void;
    const pendingAccounts = new Promise<typeof staleAccounts>((resolve) => {
      finishAccounts = resolve;
    });
    mockClient.getAccounts.mockReturnValueOnce(pendingAccounts);

    let refreshing!: Promise<void>;
    act(() => {
      refreshing = notifyStateChanged();
    });
    expect(mockClient.getAccounts).toHaveBeenCalledTimes(2);

    const generation = useMidenStore.getState().cacheGeneration;
    act(() => {
      useMidenStore.getState().resetInMemoryState();
    });
    expect(useMidenStore.getState().cacheGeneration).toBe(generation + 1);

    await act(async () => {
      finishAccounts(staleAccounts);
      await refreshing;
    });

    expect(useMidenStore.getState().accounts).toEqual([]);
    expect(useMidenStore.getState().sync.syncHeight).toBe(0);
    expect(useMidenStore.getState().sync.lastSyncTime).toBeNull();
    expect(useMidenStore.getState().sync.error).toBeNull();
  });
});

describe("MidenStore resetInMemoryState", () => {
  it("clears cached data but keeps client and config", () => {
    const store = useMidenStore.getState();

    // Set up some state
    const mockClient = {} as any;
    store.setClient(mockClient);
    store.setConfig({ rpcUrl: "https://rpc.testnet.miden.io" });
    store.setSignerConnected(true);

    // Verify state is set
    expect(useMidenStore.getState().client).toBe(mockClient);
    expect(useMidenStore.getState().isReady).toBe(true);

    // Reset in-memory state
    useMidenStore.getState().resetInMemoryState();

    // Client, isReady, config should be preserved
    const after = useMidenStore.getState();
    expect(after.client).toBe(mockClient);
    expect(after.isReady).toBe(true);
    expect(after.config).toEqual({ rpcUrl: "https://rpc.testnet.miden.io" });
    expect(after.signerConnected).toBe(true);

    // Cached data should be cleared
    expect(after.accounts).toEqual([]);
    expect(after.accountDetails.size).toBe(0);
    expect(after.notesByFilter.size).toBe(0);
    expect(after.consumableNotesByAccount.size).toBe(0);
    expect(after.assetMetadata.size).toBe(0);
    expect(after.noteFirstSeen.size).toBe(0);
    expect(after.sync.syncHeight).toBe(0);
  });
});

describe("MidenStore signerConnected", () => {
  it("starts as null", () => {
    useMidenStore.getState().reset();
    expect(useMidenStore.getState().signerConnected).toBeNull();
  });

  it("can be set to true", () => {
    useMidenStore.getState().setSignerConnected(true);
    expect(useMidenStore.getState().signerConnected).toBe(true);
  });

  it("can be set to false", () => {
    useMidenStore.getState().setSignerConnected(false);
    expect(useMidenStore.getState().signerConnected).toBe(false);
  });

  it("can be set back to null", () => {
    useMidenStore.getState().setSignerConnected(true);
    useMidenStore.getState().setSignerConnected(null);
    expect(useMidenStore.getState().signerConnected).toBeNull();
  });

  it("is cleared on full reset", () => {
    useMidenStore.getState().setSignerConnected(true);
    useMidenStore.getState().reset();
    expect(useMidenStore.getState().signerConnected).toBeNull();
  });
});
