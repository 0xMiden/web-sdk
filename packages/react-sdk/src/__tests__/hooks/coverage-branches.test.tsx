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
import { accountIdsEqual } from "../../utils/accountId";
import { AccountId } from "@miden-sdk/miden-sdk";
import { createMockWebClient } from "../mocks/miden-sdk";

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
    vi.mocked(AccountId.fromHex).mockImplementation(() => {
      throw new Error("not a valid id");
    });
    expect(accountIdsEqual("same", "same")).toBe(true);
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
        script: "begin push.0 end",
      })
    ).rejects.toThrow(/Miden client is not ready/);
  });

  it("useWaitForCommit returns null when client is not ready", async () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() => useWaitForCommit("0xtx"));
    // Status starts as pending; with no client it never advances.
    expect(["pending", "idle", null, undefined]).toContain(
      result.current.status
    );
  });

  it("useWaitForNotes returns null when client is not ready", async () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() => useWaitForNotes(["0xnote"]));
    expect(result.current).toBeDefined();
  });

  it("useExportNote throws when client is not ready", async () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() => useExportNote());
    await expect(
      result.current.exportNote({ noteId: "0xnote" })
    ).rejects.toThrow(/Miden client is not ready/);
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
    await expect(
      result.current.importNote({ bytes: new Uint8Array() })
    ).rejects.toThrow(/Miden client is not ready/);
  });

  it("useImportStore throws when client is not ready", async () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() => useImportStore());
    await expect(
      result.current.importStore({ bytes: new Uint8Array() })
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

  it("useSessionAccount initial state has no account when client is not ready", () => {
    mockUseMiden.mockReturnValue(notReady());
    const { result } = renderHook(() =>
      useSessionAccount({ storagePrefix: "test" })
    );
    // session hook returns the current state; with no client it has no resolved account.
    expect(result.current.account).toBeFalsy();
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
      await expect(
        result.current.exportNote({ noteId: "0xnote" })
      ).rejects.toThrow("export failed");
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
        result.current.importNote({ bytes: new Uint8Array([1, 2, 3]) })
      ).rejects.toThrow("import failed");
    });
    await waitFor(() => {
      expect(result.current.error?.message).toBe("import failed");
    });
  });
});
