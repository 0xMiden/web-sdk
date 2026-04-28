/**
 * Branch-coverage targeted tests. Each `it` block exists to cover a specific
 * conditional branch flagged by the coverage report (typically: error catch
 * paths, optional-chain falsy branches, "client not ready" guards, and
 * default-case fallbacks).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import { useExecuteProgram } from "../../hooks/useExecuteProgram";
import { useWaitForCommit } from "../../hooks/useWaitForCommit";
import { useWaitForNotes } from "../../hooks/useWaitForNotes";
import { useExportNote } from "../../hooks/useExportNote";
import { useExportStore } from "../../hooks/useExportStore";
import { useImportNote } from "../../hooks/useImportNote";
import { useImportStore } from "../../hooks/useImportStore";
import { useTransactionHistory } from "../../hooks/useTransactionHistory";
import { useNoteStream } from "../../hooks/useNoteStream";
import { useSessionAccount } from "../../hooks/useSessionAccount";
import { useConsume } from "../../hooks/useConsume";
import { useSend } from "../../hooks/useSend";
import { useMint } from "../../hooks/useMint";
import { useSwap } from "../../hooks/useSwap";
import { useMultiSend } from "../../hooks/useMultiSend";
import { accountIdsEqual } from "../../utils/accountId";
import { AccountId } from "@miden-sdk/miden-sdk";
import {
  createMockWebClient,
  createMockAccount,
  createMockAccountId,
  createMockInputNoteRecord,
  createMockTransactionId,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));
const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

const notReady = () => ({
  client: null,
  isReady: false,
  sync: vi.fn().mockResolvedValue(undefined),
  runExclusive: <T,>(fn: () => Promise<T>) => fn(),
});

// ────────────────────────────────────────────────────────────────────────
// accountId.ts: cover the catch branch when parseAccountId throws.
// ────────────────────────────────────────────────────────────────────────
describe("accountIdsEqual — catch path", () => {
  it("falls back to literal string comparison when parseAccountId throws", () => {
    vi.mocked(AccountId.fromHex).mockImplementationOnce(() => {
      throw new Error("not a valid id");
    });
    // The first parse throws → catch returns a === b → strings differ → false.
    expect(accountIdsEqual("0xboom", "0xdiff")).toBe(false);
  });

  it("returns true via the catch path when both inputs literally match", () => {
    // Only the first fromHex call throws — the catch returns immediately
    // without touching the second arg, so a single Once-queue is enough.
    vi.mocked(AccountId.fromHex).mockImplementationOnce(() => {
      throw new Error("not a valid id");
    });
    expect(accountIdsEqual("same", "same")).toBe(true);
  });

  it("frees only idA when idB throws after idA was assigned (finally branch)", () => {
    // First fromHex succeeds (idA assigned), second throws — so the finally
    // block sees idA defined but idB undefined, exercising the falsy branch
    // of `idB?.free?.()`.
    const idAStub = { toString: () => "0xa", free: vi.fn() };
    vi.mocked(AccountId.fromHex)
      .mockImplementationOnce(() => idAStub as never)
      .mockImplementationOnce(() => {
        throw new Error("idB exploded");
      });
    expect(accountIdsEqual("0xa", "0xb")).toBe(false);
    expect(idAStub.free).toHaveBeenCalled();
  });

  it("handles AccountId stubs whose `free` is undefined (optional-chain branch)", () => {
    // Both ids are defined but neither carries a `free` method — the
    // `?.free?.()` chain takes the falsy branch on `.free`, exercising
    // the second optional in the chain.
    const noFreeA = { toString: () => "0xnoFreeA" };
    const noFreeB = { toString: () => "0xnoFreeB" };
    vi.mocked(AccountId.fromHex)
      .mockImplementationOnce(() => noFreeA as never)
      .mockImplementationOnce(() => noFreeB as never);
    expect(accountIdsEqual("0xnoFreeA", "0xnoFreeB")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// "client not ready" branches across hooks. Each hook has a guard for
// !client || !isReady that returns early or throws — covering both the
// error-throwing and early-return shapes.
// ────────────────────────────────────────────────────────────────────────
describe("hook guards — client not ready", () => {
  it("useExecuteProgram throws when client is not ready", async () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() => useExecuteProgram());
    await expect(
      result.current.execute({
        accountId: "0xacc",
        // The hook bails on the not-ready guard before touching `script`,
        // so the script object's shape doesn't matter here — cast to satisfy
        // the parameter type.
        script: {} as never,
      })
    ).rejects.toThrow(/Miden client is not ready/);
  });

  it("useWaitForCommit's waitForCommit() rejects when client is not ready", async () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() => useWaitForCommit());
    await expect(result.current.waitForCommit("0xtx")).rejects.toThrow(
      /Miden client is not ready/
    );
  });

  it("useWaitForNotes's waitForConsumableNotes() rejects when client is not ready", async () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() => useWaitForNotes());
    await expect(
      result.current.waitForConsumableNotes({ accountId: "0xacc" })
    ).rejects.toThrow(/Miden client is not ready/);
  });

  it("useExportNote throws when client is not ready", async () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() => useExportNote());
    await expect(result.current.exportNote("0xnote")).rejects.toThrow(
      /Miden client is not ready/
    );
  });

  it("useExportStore throws when client is not ready", async () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() => useExportStore());
    await expect(result.current.exportStore()).rejects.toThrow(
      /Miden client is not ready/
    );
  });

  it("useImportNote throws when client is not ready", async () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() => useImportNote());
    await expect(result.current.importNote(new Uint8Array())).rejects.toThrow(
      /Miden client is not ready/
    );
  });

  it("useImportStore throws when client is not ready", async () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() => useImportStore());
    await expect(
      result.current.importStore("dump", "TestStore")
    ).rejects.toThrow(/Miden client is not ready/);
  });

  it("useTransactionHistory returns idle initial state when client is not ready", () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() =>
      useTransactionHistory({ id: "0xtx_history" })
    );
    expect(result.current.record).toBeNull();
  });

  it("useNoteStream initial state has no client", () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() => useNoteStream());
    expect(result.current.notes).toEqual([]);
  });

  it("useSessionAccount initial state has no resolved sessionAccountId when client is not ready", () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() =>
      useSessionAccount({
        fund: vi.fn().mockResolvedValue(undefined),
        storagePrefix: "test",
      })
    );
    expect(result.current.sessionAccountId).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Error paths surfaced via state. Each hook records the thrown error in
// `error` so the caller can render it; covers the catch branch separately
// from the throw branch above.
// ────────────────────────────────────────────────────────────────────────
describe("hook error-state propagation", () => {
  it("useExportNote sets error when the underlying call throws", async () => {
    const mockClient = createMockWebClient({
      exportNoteFile: vi.fn().mockRejectedValue(new Error("export failed")),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useExportNote());
    await act(async () => {
      await expect(result.current.exportNote("0xnote")).rejects.toThrow(
        "export failed"
      );
    });
    await waitFor(() => {
      expect(result.current.error?.message).toBe("export failed");
    });
  });

  it("useImportNote sets error when the underlying call throws", async () => {
    const mockClient = createMockWebClient({
      importNoteFile: vi.fn().mockRejectedValue(new Error("import failed")),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useImportNote());
    await act(async () => {
      await expect(
        result.current.importNote(new Uint8Array([1, 2, 3]))
      ).rejects.toThrow("import failed");
    });
    await waitFor(() => {
      expect(result.current.error?.message).toBe("import failed");
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// "non-Error rejection" branches: hooks normalize a thrown non-Error via
// `err instanceof Error ? err : new Error(String(err))`. The Error branch
// is covered by the suites above; exercise the false branch by throwing
// a plain string.
// ────────────────────────────────────────────────────────────────────────
describe("hook catch — non-Error rejection branch", () => {
  it("useExportNote wraps a string rejection in a new Error", async () => {
    const mockClient = createMockWebClient({
      exportNoteFile: vi.fn().mockRejectedValue("string-failure"),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useExportNote());
    await act(async () => {
      await expect(result.current.exportNote("0xnote")).rejects.toThrow(
        "string-failure"
      );
    });
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("string-failure");
    });
  });

  it("useExportStore wraps a string rejection in a new Error", async () => {
    const mockClient = createMockWebClient({
      // sdkExportStore reads via runExclusive; throw at storeIdentifier
      // resolution to enter the catch with a non-Error value.
      storeIdentifier: vi.fn(() => {
        throw "store-id-fail";
      }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useExportStore());
    await act(async () => {
      await expect(result.current.exportStore()).rejects.toThrow(
        "store-id-fail"
      );
    });
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("store-id-fail");
    });
  });

  it("useImportNote wraps a string rejection in a new Error", async () => {
    const mockClient = createMockWebClient({
      importNoteFile: vi.fn().mockRejectedValue("import-string-fail"),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useImportNote());
    await act(async () => {
      await expect(
        result.current.importNote(new Uint8Array([1, 2, 3]))
      ).rejects.toThrow("import-string-fail");
    });
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("import-string-fail");
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// useSessionAccount: cover the "private" storageMode branch (line 203) and
// the timeout branch in waitAndConsume (line 253) when consumable notes
// never arrive within maxWaitMs.
// ────────────────────────────────────────────────────────────────────────
describe("useSessionAccount — storage mode + timeout branches", () => {
  it("uses AccountStorageMode.private when walletOptions.storageMode === 'private'", async () => {
    const mockWallet = createMockAccount({
      id: vi.fn(() => createMockAccountId("0xprivate_wallet")),
    });
    const consumable = {
      inputNoteRecord: vi.fn(() => ({ toNote: vi.fn(() => ({})) })),
    };
    const newWallet = vi.fn().mockResolvedValue(mockWallet);
    const mockClient = createMockWebClient({
      newWallet,
      getConsumableNotes: vi.fn().mockResolvedValue([consumable]),
      newConsumeTransactionRequest: vi.fn().mockReturnValue({}),
      submitNewTransaction: vi.fn().mockResolvedValue({
        toString: () => "0xtx_priv",
      }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
    });

    // Use a unique storagePrefix so localStorage state from previous tests
    // doesn't restore a "ready" session before this test runs.
    const { result } = renderHook(() =>
      useSessionAccount({
        fund: vi.fn().mockResolvedValue(undefined),
        assetId: "0xfaucet",
        pollIntervalMs: 1,
        maxWaitMs: 100,
        walletOptions: { storageMode: "private" },
        storagePrefix: `priv-storage-${Math.random()}`,
      })
    );

    await act(async () => {
      await result.current.initialize();
    });

    // The first arg to newWallet is the resolved storage mode object;
    // our mock for AccountStorageMode.private returns { type: "private" }.
    const firstArg = newWallet.mock.calls[0][0];
    expect((firstArg as { type: string }).type).toBe("private");
  });

  it("wraps a non-Error rejection from initialize in a new Error (catch instanceof branch)", async () => {
    const mockClient = createMockWebClient({
      newWallet: vi.fn().mockRejectedValue("session-string-fail"),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
    });

    const { result } = renderHook(() =>
      useSessionAccount({
        fund: vi.fn().mockResolvedValue(undefined),
        assetId: "0xfaucet",
        storagePrefix: `non-error-${Math.random()}`,
      })
    );

    await act(async () => {
      await expect(result.current.initialize()).rejects.toThrow(
        "session-string-fail"
      );
    });
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("session-string-fail");
  });

  it("returns early after fund() when reset() flips cancelledRef mid-flight", async () => {
    let releaseFund: () => void;
    const fund = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFund = resolve;
        })
    );
    const mockWallet = createMockAccount({
      id: vi.fn(() => createMockAccountId("0xcancel_wallet")),
    });
    const mockClient = createMockWebClient({
      newWallet: vi.fn().mockResolvedValue(mockWallet),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
    });

    const { result } = renderHook(() =>
      useSessionAccount({
        fund,
        assetId: "0xfaucet",
        pollIntervalMs: 1,
        maxWaitMs: 50,
        storagePrefix: `cancel-mid-fund-${Math.random()}`,
      })
    );

    let initPromise: Promise<unknown>;
    act(() => {
      initPromise = result.current.initialize().catch(() => {});
    });
    // Wait until fund() is in flight.
    await waitFor(() => {
      expect(fund).toHaveBeenCalled();
    });

    // Reset flips cancelledRef.current = true.
    act(() => {
      result.current.reset();
    });

    // Now release fund. The post-fund check returns early.
    await act(async () => {
      releaseFund!();
      await initPromise!;
    });

    // Step never advanced past "funding" (or back to idle via reset).
    expect(result.current.step).toBe("idle");
  });

  it("falls back to public storage mode when walletOptions.storageMode is unknown (default branch)", async () => {
    const mockWallet = createMockAccount({
      id: vi.fn(() => createMockAccountId("0xfallback_wallet")),
    });
    const consumable = {
      inputNoteRecord: vi.fn(() => ({ toNote: vi.fn(() => ({})) })),
    };
    const newWallet = vi.fn().mockResolvedValue(mockWallet);
    const mockClient = createMockWebClient({
      newWallet,
      getConsumableNotes: vi.fn().mockResolvedValue([consumable]),
      newConsumeTransactionRequest: vi.fn().mockReturnValue({}),
      submitNewTransaction: vi.fn().mockResolvedValue({
        toString: () => "0xtx_default",
      }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
    });

    const { result } = renderHook(() =>
      useSessionAccount({
        fund: vi.fn().mockResolvedValue(undefined),
        assetId: "0xfaucet",
        pollIntervalMs: 1,
        maxWaitMs: 100,
        // Cast through unknown to bypass the union type and exercise the
        // default case in getStorageMode.
        walletOptions: { storageMode: "unknown" as unknown as "public" },
        storagePrefix: `default-storage-${Math.random()}`,
      })
    );

    await act(async () => {
      await result.current.initialize();
    });

    // The default arm returns AccountStorageMode.public(), same { type: "public" }.
    const firstArg = newWallet.mock.calls[0][0];
    expect((firstArg as { type: string }).type).toBe("public");
  });

  it("throws 'Timeout waiting for session wallet funding' when no notes arrive", async () => {
    const mockWallet = createMockAccount({
      id: vi.fn(() => createMockAccountId("0xtimeout_wallet")),
    });
    const mockClient = createMockWebClient({
      newWallet: vi.fn().mockResolvedValue(mockWallet),
      // Always returns empty so the deadline expires.
      getConsumableNotes: vi.fn().mockResolvedValue([]),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
    });

    const { result } = renderHook(() =>
      useSessionAccount({
        fund: vi.fn().mockResolvedValue(undefined),
        assetId: "0xfaucet",
        pollIntervalMs: 1,
        maxWaitMs: 5,
        storagePrefix: `timeout-${Math.random()}`,
      })
    );

    await act(async () => {
      await expect(result.current.initialize()).rejects.toThrow(
        /Timeout waiting for session wallet funding/
      );
    });
    expect(result.current.error?.message).toMatch(
      /Timeout waiting for session wallet funding/
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// useWaitForCommit: cover the timeout branch (no record found) and
// normalizeHex no-`0x`-prefix branch.
// ────────────────────────────────────────────────────────────────────────
describe("useWaitForCommit — timeout + normalizeHex prefix branches", () => {
  it("throws 'Timeout waiting for transaction commit' when deadline elapses", async () => {
    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      // Empty array → no record found → loop spins until timeout.
      getTransactions: vi.fn().mockResolvedValue([]),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useWaitForCommit());
    await expect(
      result.current.waitForCommit("0xtx", { timeoutMs: 5, intervalMs: 1 })
    ).rejects.toThrow(/Timeout waiting for transaction commit/);
  });

  it("matches a record whose id() returns a non-`0x`-prefixed hex string", async () => {
    // Caller supplies "deadbeef" (no prefix); the SDK record returns
    // "deadbeef" too. Both must be normalized to "0xdeadbeef" to match.
    const record = {
      id: vi.fn(() => ({ toHex: () => "deadbeef" })),
      transactionStatus: vi.fn(() => ({
        isPending: () => false,
        isCommitted: () => true,
        isDiscarded: () => false,
      })),
    };
    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      getTransactions: vi.fn().mockResolvedValue([record]),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useWaitForCommit());
    await result.current.waitForCommit("deadbeef", {
      timeoutMs: 50,
      intervalMs: 1,
    });
    // No throw → record was matched via the no-prefix normalize branch.
    expect(record.transactionStatus).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────
// useWaitForNotes: cover the timeout branch.
// ────────────────────────────────────────────────────────────────────────
describe("useWaitForNotes — timeout branch", () => {
  it("throws 'Timeout waiting for consumable notes' when count never reaches minCount", async () => {
    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      // Always empty → length never reaches minCount → loop times out.
      getConsumableNotes: vi.fn().mockResolvedValue([]),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useWaitForNotes());
    await expect(
      result.current.waitForConsumableNotes({
        accountId: "0xacc",
        timeoutMs: 5,
        intervalMs: 1,
      })
    ).rejects.toThrow(/Timeout waiting for consumable notes/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// useConsume: cover the prover branch and the length-mismatch error.
// ────────────────────────────────────────────────────────────────────────
describe("useConsume — prover + length-mismatch branches", () => {
  it("uses submitNewTransactionWithProver when prover is provided", async () => {
    const submitWithProver = vi
      .fn()
      .mockResolvedValue(createMockTransactionId("0xtx_consume_prover"));
    const submitWithout = vi.fn();
    const inputNote = createMockInputNoteRecord("0xnote_p");
    const mockClient = createMockWebClient({
      submitNewTransactionWithProver: submitWithProver,
      submitNewTransaction: submitWithout,
      newConsumeTransactionRequest: vi.fn().mockReturnValue({}),
    });

    const fakeProver = { kind: "remote-prover" } as never;
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
      prover: fakeProver,
    });

    const { result } = renderHook(() => useConsume());
    await act(async () => {
      await result.current.consume({
        accountId: "0xacc",
        notes: [inputNote as never],
      });
    });

    expect(submitWithProver).toHaveBeenCalled();
    expect(submitWithout).not.toHaveBeenCalled();
  });

  it("throws when getInputNotes returns fewer records than requested IDs", async () => {
    // Two string IDs are supplied. Both go through the lookup path.
    // The lookup returns only one record → length mismatch error.
    const onlyRecord = createMockInputNoteRecord("0xnoteA");
    const mockClient = createMockWebClient({
      getInputNotes: vi.fn().mockResolvedValue([onlyRecord]),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useConsume());
    await act(async () => {
      await expect(
        result.current.consume({
          accountId: "0xacc",
          notes: ["0xnoteA", "0xnoteB"],
        })
      ).rejects.toThrow(/Some notes could not be found/);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// useSend: cover the private-send prover branch and extractFullNote catch.
// ────────────────────────────────────────────────────────────────────────
describe("useSend — returnNote prover branch + extractFullNote catch", () => {
  it("returnNote path uses submitNewTransactionWithProver when prover is provided", async () => {
    const submitWithProver = vi
      .fn()
      .mockResolvedValue(createMockTransactionId("0xtx_returnNote_prover"));
    const submitWithout = vi.fn();
    const mockClient = createMockWebClient({
      submitNewTransactionWithProver: submitWithProver,
      submitNewTransaction: submitWithout,
    });

    const fakeProver = { kind: "remote-prover" } as never;
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
      prover: fakeProver,
    });

    const { result } = renderHook(() => useSend());
    await act(async () => {
      await result.current.send({
        from: "0xsender",
        to: "0xrecipient",
        assetId: "0xfaucet",
        amount: 100n,
        noteType: "public",
        returnNote: true,
      });
    });

    expect(submitWithProver).toHaveBeenCalled();
    expect(submitWithout).not.toHaveBeenCalled();
  });

  it("returnNote path uses submitNewTransaction when prover is absent", async () => {
    const submitWithProver = vi.fn();
    const submitWithout = vi
      .fn()
      .mockResolvedValue(createMockTransactionId("0xtx_returnNote_no_prover"));
    const mockClient = createMockWebClient({
      submitNewTransactionWithProver: submitWithProver,
      submitNewTransaction: submitWithout,
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useSend());
    await act(async () => {
      await result.current.send({
        from: "0xsender",
        to: "0xrecipient",
        assetId: "0xfaucet",
        amount: 100n,
        noteType: "public",
        returnNote: true,
      });
    });

    expect(submitWithout).toHaveBeenCalled();
    expect(submitWithProver).not.toHaveBeenCalled();
  });

  it("throws 'Asset ID is required' when neither assetId nor faucetId is supplied", async () => {
    const mockClient = createMockWebClient({});
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useSend());
    await act(async () => {
      await expect(
        // Cast to never to bypass the SendOptions discriminated union check.
        result.current.send({
          from: "0xsender",
          to: "0xrecipient",
          amount: 1n,
          noteType: "public",
        } as never)
      ).rejects.toThrow(/Asset ID is required/);
    });
  });

  it("falls back to options.faucetId when options.assetId is undefined", async () => {
    const txResult = {
      id: () => ({ toString: () => "0xtx", toHex: () => "0xtx" }),
      executedTransaction: () => ({
        outputNotes: () => ({ notes: () => [] }),
      }),
    };
    const newSendReq = vi.fn().mockResolvedValue({});
    const mockClient = createMockWebClient({
      executeTransaction: vi.fn().mockResolvedValue(txResult),
      proveTransaction: vi.fn().mockResolvedValue({}),
      submitProvenTransaction: vi.fn().mockResolvedValue(100),
      applyTransaction: vi.fn().mockResolvedValue({}),
      newSendTransactionRequest: newSendReq,
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useSend());
    await act(async () => {
      await result.current.send({
        from: "0xsender",
        to: "0xrecipient",
        // assetId omitted, faucetId provided — exercises the ?? fallback.
        faucetId: "0xfaucet_fallback",
        amount: 100n,
        noteType: "public",
      } as never);
    });

    expect(newSendReq).toHaveBeenCalled();
  });

  it("extractFullNote returns null when executedTransaction throws (catch branch)", async () => {
    // Build a tx result whose executedTransaction throws. extractFullNote
    // should swallow the error and return null, so the Private-send
    // post-check throws "Missing full note for private send".
    const txResult = {
      id: () => ({ toString: () => "0xtx", toHex: () => "0xtx" }),
      executedTransaction: () => {
        throw new Error("WASM consumed");
      },
    };
    const mockClient = createMockWebClient({
      executeTransaction: vi.fn().mockResolvedValue(txResult),
      proveTransaction: vi.fn().mockResolvedValue({}),
      submitProvenTransaction: vi.fn().mockResolvedValue(100),
      applyTransaction: vi.fn().mockResolvedValue({}),
      newSendTransactionRequest: vi.fn().mockResolvedValue({}),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useSend());
    await act(async () => {
      await expect(
        result.current.send({
          from: "0xsender",
          to: "0xrecipient",
          assetId: "0xfaucet",
          amount: 100n,
          noteType: "private",
        })
      ).rejects.toThrow(/Missing full note for private send/);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// useNoteStream: cover the asset-loop catch and outer buildStreamedNote
// catch (lines 226 and 245-246).
// ────────────────────────────────────────────────────────────────────────
describe("useNoteStream — buildStreamedNote catch paths", () => {
  it("returns notes with empty assets when details() throws (asset-loop catch)", async () => {
    // metadata is intact (sender resolves), but details() throws — the inner
    // try/catch in buildStreamedNote should keep assets empty rather than
    // bailing on the whole note.
    const noteWithBrokenDetails = {
      id: vi.fn(() => ({ toString: () => "0xnote_broken_assets" })),
      metadata: vi.fn(() => ({
        sender: vi.fn(() => ({ toString: () => "0xsenderX" })),
        attachment: vi.fn(() => null),
      })),
      details: vi.fn(() => {
        throw new Error("asset details unavailable");
      }),
      free: vi.fn(),
    };

    const mockClient = createMockWebClient({
      getInputNotes: vi.fn().mockResolvedValue([noteWithBrokenDetails]),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useMidenStore.getState().setNotes([noteWithBrokenDetails as any]);

    const { result } = renderHook(() => useNoteStream());
    await waitFor(() => {
      expect(result.current.notes.length).toBe(1);
    });

    const note = result.current.notes[0];
    expect(note.id).toBe("0xnote_broken_assets");
    // assets array stayed empty after the catch swallowed the error.
    expect(note.assets).toEqual([]);
    expect(note.amount).toBe(0n);
  });

  it("filters out the note when record.id() throws (outer buildStreamedNote catch)", async () => {
    // The very first call inside buildStreamedNote — record.id().toString() —
    // throws. The outer catch returns null and the note is filtered out.
    const noteWithBrokenId = {
      id: vi.fn(() => {
        throw new Error("id() failed");
      }),
      metadata: vi.fn(() => null),
      details: vi.fn(() => ({})),
      free: vi.fn(),
    };

    const mockClient = createMockWebClient({
      getInputNotes: vi.fn().mockResolvedValue([noteWithBrokenId]),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useMidenStore.getState().setNotes([noteWithBrokenId as any]);

    const { result } = renderHook(() => useNoteStream());
    await waitFor(() => {
      // Allow the effect / memo to run; a broken note yields zero output.
      expect(result.current.notes.length).toBe(0);
    });
  });

  it("handles a record with no metadata() (metadata?.()? optional chain)", async () => {
    const recordNoMetadata = {
      id: vi.fn(() => ({ toString: () => "0xno_metadata" })),
      // No metadata method.
      details: vi.fn(() => ({})),
      free: vi.fn(),
    };
    const mockClient = createMockWebClient({
      getInputNotes: vi.fn().mockResolvedValue([recordNoMetadata]),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useMidenStore.getState().setNotes([recordNoMetadata as any]);

    const { result } = renderHook(() => useNoteStream());
    await waitFor(() => {
      expect(result.current.notes.length).toBe(1);
    });
    expect(result.current.notes[0].sender).toBe("");
  });

  it("handles metadata whose sender() returns null (null-sender branch)", async () => {
    const recordNullSender = {
      id: vi.fn(() => ({ toString: () => "0xnull_sender" })),
      metadata: vi.fn(() => ({
        sender: vi.fn(() => null),
        attachment: vi.fn(() => null),
      })),
      details: vi.fn(() => ({})),
      free: vi.fn(),
    };
    const mockClient = createMockWebClient({
      getInputNotes: vi.fn().mockResolvedValue([recordNullSender]),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useMidenStore.getState().setNotes([recordNullSender as any]);

    const { result } = renderHook(() => useNoteStream());
    await waitFor(() => {
      expect(result.current.notes.length).toBe(1);
    });
    // senderHex is undefined → sender stays "".
    expect(result.current.notes[0].sender).toBe("");
  });

  it("uses a previously-recorded firstSeenAt timestamp when available", async () => {
    const record1 = {
      id: vi.fn(() => ({ toString: () => "0xseen_before" })),
      metadata: vi.fn(() => null),
      details: vi.fn(() => ({})),
      free: vi.fn(),
    };

    const mockClient = createMockWebClient({
      getInputNotes: vi.fn().mockResolvedValue([record1]),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });
    // Pre-populate noteFirstSeen.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useMidenStore.getState().setNotes([record1 as any]);
    const recordedAt = useMidenStore
      .getState()
      .noteFirstSeen.get("0xseen_before");

    const { result } = renderHook(() => useNoteStream());
    await waitFor(() => {
      expect(result.current.notes.length).toBe(1);
    });
    // Returned firstSeenAt should match the pre-recorded timestamp.
    expect(result.current.notes[0].firstSeenAt).toBe(recordedAt);
  });

  it("filters by `since` and excludes notes seen before the threshold", async () => {
    const oldNote = {
      id: vi.fn(() => ({ toString: () => "0xold" })),
      metadata: vi.fn(() => null),
      details: vi.fn(() => ({})),
      free: vi.fn(),
    };
    const mockClient = createMockWebClient({
      getInputNotes: vi.fn().mockResolvedValue([oldNote]),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useMidenStore.getState().setNotes([oldNote as any]);

    // Future since timestamp ensures the existing first-seen is excluded.
    const futureSince = Date.now() + 60_000;
    const { result } = renderHook(() => useNoteStream({ since: futureSince }));

    await waitFor(() => {
      expect(result.current.notes.length).toBe(0);
    });
  });

  it("captures refetch errors as state when getInputNotes throws", async () => {
    const mockClient = createMockWebClient({
      getInputNotes: vi
        .fn()
        .mockRejectedValue(new Error("notes fetch exploded")),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });

    const { result } = renderHook(() => useNoteStream());
    await waitFor(() => {
      expect(result.current.error?.message).toBe("notes fetch exploded");
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// useExecuteProgram: cover the foreign-account branches —
// (a) wrapper rejected when its `id` is a function (line 54-55), and
// (b) wrapper supplied without `.storage` falls back to a default
//     AccountStorageRequirements (line 102).
// ────────────────────────────────────────────────────────────────────────
describe("useExecuteProgram — foreign-account branches", () => {
  it("treats a wrapper-shaped object as raw id when its `id` is a function", async () => {
    // `isForeignAccountWrapper` rejects when typeof obj.id === 'function'.
    // The hook then falls back to `parseAccountId(fa as string)`. With our
    // fromHex mock returning a stub, this should resolve and call execute.
    const mockSync = vi.fn().mockResolvedValue(undefined);
    const mockClient = createMockWebClient({
      executeProgram: vi.fn().mockResolvedValue({
        length: () => 0,
        get: () => ({ asInt: () => 0n }),
      }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: mockSync,
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useExecuteProgram());

    const wrapperWithFnId = {
      id: () => "0xforeign",
      storage: { __storage: true },
    };

    await act(async () => {
      await result.current.execute({
        accountId: "0xacc",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        script: {} as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        foreignAccounts: [wrapperWithFnId as any],
      });
    });

    // Reaches executeProgram → branch (a) was exercised.
    expect(mockClient.executeProgram).toHaveBeenCalled();
  });

  it("uses the wrapper's `storage` when supplied (wrapper truthy + storage truthy branch)", async () => {
    const mockSync = vi.fn().mockResolvedValue(undefined);
    const mockClient = createMockWebClient({
      executeProgram: vi.fn().mockResolvedValue({
        length: () => 0,
        get: () => ({ asInt: () => 0n }),
      }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: mockSync,
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useExecuteProgram());

    // Wrapper-shaped object with explicit `storage`. Because `id` is a
    // string (not a function), isForeignAccountWrapper returns true → the
    // truthy branch of `wrapper && fa.storage` fires.
    const wrapperWithStorage = {
      id: "0xfg_with_storage",
      storage: { kind: "explicit-storage" },
    };

    await act(async () => {
      await result.current.execute({
        accountId: "0xacc",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        script: {} as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        foreignAccounts: [wrapperWithStorage as any],
      });
    });

    expect(mockClient.executeProgram).toHaveBeenCalled();
  });

  it("uses a default AccountStorageRequirements when wrapper.storage is missing", async () => {
    const mockSync = vi.fn().mockResolvedValue(undefined);
    const mockClient = createMockWebClient({
      executeProgram: vi.fn().mockResolvedValue({
        length: () => 0,
        get: () => ({ asInt: () => 0n }),
      }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: mockSync,
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useExecuteProgram());

    // Wrapper has `id` (string, NOT a function) but NO `.storage` —
    // the hook should construct a default AccountStorageRequirements.
    const wrapperWithoutStorage = { id: "0xforeign_no_storage" };

    await act(async () => {
      await result.current.execute({
        accountId: "0xacc",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        script: {} as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        foreignAccounts: [wrapperWithoutStorage as any],
      });
    });

    expect(mockClient.executeProgram).toHaveBeenCalled();
  });

  it("captures string-rejection errors and wraps them in a new Error", async () => {
    const mockClient = createMockWebClient({
      executeProgram: vi.fn().mockRejectedValue("string-exec-fail"),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useExecuteProgram());
    await act(async () => {
      await expect(
        result.current.execute({
          accountId: "0xacc",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          script: {} as any,
        })
      ).rejects.toThrow("string-exec-fail");
    });
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("string-exec-fail");
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// useMint / useSwap / useConsume / useSend / useMultiSend: cover the
// non-Error rejection branch in their catch blocks (`err instanceof Error
// ? err : new Error(String(err))`).
// ────────────────────────────────────────────────────────────────────────
describe("transaction hooks — non-Error rejection branches", () => {
  it("useMint wraps a string rejection in a new Error", async () => {
    const mockClient = createMockWebClient({
      newMintTransactionRequest: vi.fn().mockResolvedValue({}),
      submitNewTransaction: vi.fn().mockRejectedValue("mint-string-fail"),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useMint());
    await act(async () => {
      await expect(
        result.current.mint({
          targetAccountId: "0xacc",
          faucetId: "0xfaucet",
          amount: 100n,
        })
      ).rejects.toThrow("mint-string-fail");
    });
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("mint-string-fail");
    });
  });

  it("useSwap wraps a string rejection in a new Error", async () => {
    const mockClient = createMockWebClient({
      newSwapTransactionRequest: vi.fn().mockResolvedValue({}),
      submitNewTransaction: vi.fn().mockRejectedValue("swap-string-fail"),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useSwap());
    await act(async () => {
      await expect(
        result.current.swap({
          accountId: "0xacc",
          offeredFaucetId: "0xa",
          offeredAmount: 1n,
          requestedFaucetId: "0xb",
          requestedAmount: 2n,
        })
      ).rejects.toThrow("swap-string-fail");
    });
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("swap-string-fail");
    });
  });

  it("useConsume wraps a string rejection in a new Error", async () => {
    const inputNote = createMockInputNoteRecord("0xnote_for_string_fail");
    const mockClient = createMockWebClient({
      submitNewTransaction: vi.fn().mockRejectedValue("consume-string-fail"),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useConsume());
    await act(async () => {
      await expect(
        result.current.consume({
          accountId: "0xacc",
          notes: [inputNote as never],
        })
      ).rejects.toThrow("consume-string-fail");
    });
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("consume-string-fail");
    });
  });

  it("useSend wraps a string rejection in a new Error", async () => {
    const mockClient = createMockWebClient({
      newSendTransactionRequest: vi.fn().mockRejectedValue("send-string-fail"),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useSend());
    await act(async () => {
      await expect(
        result.current.send({
          from: "0xsender",
          to: "0xrecipient",
          assetId: "0xfaucet",
          amount: 100n,
          noteType: "public",
        })
      ).rejects.toThrow("send-string-fail");
    });
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("send-string-fail");
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// useTransactionHistory: cover (a) the early-return when a custom filter
// is supplied, (b) the no-prefix normalizeHex branch, and (c) the catch
// path when getTransactions throws.
// ────────────────────────────────────────────────────────────────────────
describe("useTransactionHistory — filter + catch + normalizeHex", () => {
  it("uses a caller-supplied TransactionFilter without falling back to all/ids", async () => {
    const customFilter = { __custom: true };
    const getTx = vi.fn().mockResolvedValue([]);
    const mockClient = createMockWebClient({
      getTransactions: getTx,
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() =>
      useTransactionHistory({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filter: customFilter as any,
      })
    );
    await waitFor(() => {
      expect(getTx).toHaveBeenCalledWith(customFilter);
    });
    expect(result.current.error).toBeNull();
  });

  it("matches a string id with no `0x` prefix (normalizeHex prepends it)", async () => {
    const record = {
      id: vi.fn(() => ({ toHex: () => "abc123" })),
      transactionStatus: vi.fn(() => ({
        isPending: () => false,
        isCommitted: () => true,
        isDiscarded: () => false,
      })),
    };
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([record]),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    // Caller passes "abc123" without a 0x prefix — normalizeHex should
    // canonicalize to "0xabc123" on both sides so the record matches.
    const { result } = renderHook(() =>
      useTransactionHistory({ ids: ["abc123"] })
    );
    await waitFor(() => {
      expect(result.current.records).toHaveLength(1);
    });
    expect(result.current.status).toBe("committed");
  });

  it("returns 'pending' status for a pending record", async () => {
    const record = {
      id: vi.fn(() => ({ toHex: () => "0xpending" })),
      transactionStatus: vi.fn(() => ({
        isPending: () => true,
        isCommitted: () => false,
        isDiscarded: () => false,
      })),
    };
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([record]),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() =>
      useTransactionHistory({ ids: ["0xpending"] })
    );
    await waitFor(() => {
      expect(result.current.status).toBe("pending");
    });
  });

  it("returns null status when none of pending/committed/discarded matches", async () => {
    const record = {
      id: vi.fn(() => ({ toHex: () => "0xnone" })),
      transactionStatus: vi.fn(() => ({
        isPending: () => false,
        isCommitted: () => false,
        isDiscarded: () => false,
      })),
    };
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([record]),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() =>
      useTransactionHistory({ ids: ["0xnone"] })
    );
    await waitFor(() => {
      expect(result.current.records).toHaveLength(1);
    });
    // All three flags false → status falls through the if-chain to null.
    expect(result.current.status).toBeNull();
  });

  it("re-fetches when lastSyncTime changes (refreshOnSync default)", async () => {
    const getTx = vi.fn().mockResolvedValue([]);
    const mockClient = createMockWebClient({
      getTransactions: getTx,
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    renderHook(() => useTransactionHistory());
    // Initial fetch on mount.
    await waitFor(() => {
      expect(getTx).toHaveBeenCalledTimes(1);
    });

    // Bump lastSyncTime — the second useEffect should fire and refetch.
    act(() => {
      useMidenStore.getState().setSyncState({ lastSyncTime: Date.now() });
    });
    await waitFor(() => {
      expect(getTx.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("captures errors from getTransactions in `error` state", async () => {
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockRejectedValue(new Error("history boom")),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useTransactionHistory());
    await waitFor(() => {
      expect(result.current.error?.message).toBe("history boom");
    });
  });

  it("wraps a non-Error rejection from getTransactions in a new Error", async () => {
    const mockClient = createMockWebClient({
      getTransactions: vi.fn().mockRejectedValue("history-string-fail"),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useTransactionHistory());
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("history-string-fail");
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// useSessionAccount: cover (a) busy-guard rejection (lines 97-101), and
// (b) localStorage restore catch (lines 84-88) when stored ID is invalid.
// ────────────────────────────────────────────────────────────────────────
describe("useSessionAccount — busy guard + localStorage catch", () => {
  it("rejects a concurrent initialize() with OPERATION_BUSY", async () => {
    let releaseFund: () => void;
    const fund = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFund = resolve;
        })
    );
    const mockWallet = createMockAccount({
      id: vi.fn(() => createMockAccountId("0xbusy_wallet")),
    });
    const mockClient = createMockWebClient({
      newWallet: vi.fn().mockResolvedValue(mockWallet),
      // While fund() is pending, a second initialize() should hit busy.
      getConsumableNotes: vi.fn().mockResolvedValue([]),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
    });

    const { result } = renderHook(() =>
      useSessionAccount({
        fund,
        assetId: "0xfaucet",
        pollIntervalMs: 1,
        maxWaitMs: 50,
        storagePrefix: `busy-${Math.random()}`,
      })
    );

    // Start the first initialize — it'll hang on fund().
    let firstPromise: Promise<unknown>;
    act(() => {
      firstPromise = result.current.initialize().catch(() => {});
    });

    // Wait a tick so isBusyRef.current === true is set.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(result.current.initialize()).rejects.toThrow(
      /already in progress/
    );

    // Release the first promise so cleanup runs cleanly.
    await act(async () => {
      releaseFund!();
      await firstPromise!;
    });
  });

  it("useSend throws 'Amount is required' when neither amount nor sendAll is provided", async () => {
    const mockClient = createMockWebClient({});
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useSend());
    await act(async () => {
      await expect(
        result.current.send({
          from: "0xsender",
          to: "0xrecipient",
          assetId: "0xfaucet",
          // amount undefined, sendAll undefined.
        } as never)
      ).rejects.toThrow(/Amount is required/);
    });
  });

  it("useSend sendAll throws 'Could not query account balance' when vault is missing", async () => {
    const accountWithNoVault = {
      // vault() returns an object without getBalance.
      vault: vi.fn(() => ({})),
    };
    const mockClient = createMockWebClient({
      getAccount: vi.fn().mockResolvedValue(accountWithNoVault),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useSend());
    await act(async () => {
      await expect(
        result.current.send({
          from: "0xsender",
          to: "0xrecipient",
          assetId: "0xfaucet",
          sendAll: true,
        })
      ).rejects.toThrow(/Could not query account balance/);
    });
  });

  it("useSend sendAll throws 'Account not found' when getAccount returns null", async () => {
    const mockClient = createMockWebClient({
      getAccount: vi.fn().mockResolvedValue(null),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useSend());
    await act(async () => {
      await expect(
        result.current.send({
          from: "0xsender",
          to: "0xrecipient",
          assetId: "0xfaucet",
          sendAll: true,
        })
      ).rejects.toThrow(/Account not found/);
    });
  });

  it("useSend sendAll throws 'Account has zero balance' when balance is 0", async () => {
    const accountZeroBalance = {
      vault: vi.fn(() => ({
        getBalance: vi.fn(() => 0n),
      })),
    };
    const mockClient = createMockWebClient({
      getAccount: vi.fn().mockResolvedValue(accountZeroBalance),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useSend());
    await act(async () => {
      await expect(
        result.current.send({
          from: "0xsender",
          to: "0xrecipient",
          assetId: "0xfaucet",
          sendAll: true,
        })
      ).rejects.toThrow(/Account has zero balance for this asset/);
    });
  });

  it("useMultiSend uses per-recipient noteType + attachment when supplied", async () => {
    const txResult = {
      id: () => ({ toString: () => "0xms_attach", toHex: () => "0xms_attach" }),
    };
    const record = {
      id: vi.fn(() => ({ toHex: () => "0xms_attach" })),
      transactionStatus: vi.fn(() => ({
        isPending: vi.fn(() => false),
        isCommitted: vi.fn(() => true),
        isDiscarded: vi.fn(() => false),
      })),
    };
    const mockClient = createMockWebClient({
      executeTransaction: vi.fn().mockResolvedValue(txResult),
      proveTransaction: vi.fn().mockResolvedValue({}),
      submitProvenTransaction: vi.fn().mockResolvedValue(100),
      applyTransaction: vi.fn().mockResolvedValue({}),
      getTransactions: vi.fn().mockResolvedValue([record]),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
    });

    const { result } = renderHook(() => useMultiSend());
    await act(async () => {
      await result.current.sendMany({
        from: "0xsender",
        assetId: "0xfaucet",
        recipients: [
          {
            to: "0xrecipient",
            amount: 50n,
            // Per-recipient overrides: exercises lines 120-122 + 123-126
            noteType: "public",
            attachment: [1n, 2n, 3n, 4n],
          },
        ],
      });
    });

    expect(result.current.stage).toBe("complete");
  });

  it("useMultiSend wraps a string rejection in a new Error and resets state on reset()", async () => {
    const mockClient = createMockWebClient({
      executeTransaction: vi.fn().mockRejectedValue("multisend-string-fail"),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
    });

    const { result } = renderHook(() => useMultiSend());
    await act(async () => {
      await expect(
        result.current.sendMany({
          from: "0xsender",
          assetId: "0xfaucet",
          recipients: [{ to: "0xr", amount: 1n }],
        })
      ).rejects.toThrow("multisend-string-fail");
    });
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("multisend-string-fail");
    });
    expect(result.current.stage).toBe("idle");

    // Reset clears the state.
    act(() => {
      result.current.reset();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.result).toBeNull();
    expect(result.current.stage).toBe("idle");
  });

  it("clears invalid stored data and starts fresh when restore throws", () => {
    // Pre-seed localStorage with a string the parseAccountId mock will
    // reject. We force AccountId.fromHex to throw once during restore so
    // the validationId line throws and the catch removes both keys.
    const prefix = `restore-fail-${Math.random()}`;
    localStorage.setItem(`${prefix}:accountId`, "garbage");
    localStorage.setItem(`${prefix}:ready`, "true");

    vi.mocked(AccountId.fromHex).mockImplementationOnce(() => {
      throw new Error("invalid stored id");
    });

    const removeSpy = vi.spyOn(Storage.prototype, "removeItem");

    mockUseMiden.mockReturnValue({
      client: null,
      isReady: false,
      sync: vi.fn(),
    });

    renderHook(() =>
      useSessionAccount({
        fund: vi.fn().mockResolvedValue(undefined),
        assetId: "0xfaucet",
        storagePrefix: prefix,
      })
    );

    expect(removeSpy).toHaveBeenCalledWith(`${prefix}:accountId`);
    expect(removeSpy).toHaveBeenCalledWith(`${prefix}:ready`);
    removeSpy.mockRestore();
  });
});
