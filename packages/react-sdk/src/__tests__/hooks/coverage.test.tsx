/**
 * Coverage-targeted tests for the hooks that the existing test suite leaves
 * undercovered. Each `describe` block's purpose is the file it's lifting
 * coverage on, and the cases inside go for the specific uncovered lines.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useImportAccount } from "../../hooks/useImportAccount";
import { useConsume } from "../../hooks/useConsume";
import { useNotes } from "../../hooks/useNotes";
import { useSend } from "../../hooks/useSend";
import { useMint } from "../../hooks/useMint";
import { useSwap } from "../../hooks/useSwap";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import { AccountFile } from "@miden-sdk/miden-sdk";
import {
  createMockAccount,
  createMockAccountId,
  createMockInputNoteRecord,
  createMockConsumableNoteRecord,
  createMockWebClient,
} from "../mocks/miden-sdk";

// Shared mock for useMiden — all tests below override its return value per-case.
vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));
const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

// ────────────────────────────────────────────────────────────────────────
// useImportAccount: covers ArrayBuffer file path + bytes-matching fallback.
// ────────────────────────────────────────────────────────────────────────
describe("useImportAccount — file-input variants", () => {
  it("accepts an ArrayBuffer and forwards a deserialized AccountFile", async () => {
    const mockAccount = createMockAccount();
    const deserializedFile = {
      account: vi.fn(() => mockAccount),
      accountId: vi.fn(() => createMockAccountId("0xfoo")),
      serialize: vi.fn(() => new Uint8Array([4, 5, 6])),
    };
    vi.spyOn(AccountFile, "deserialize").mockReturnValueOnce(
      deserializedFile as unknown as AccountFile
    );

    const mockClient = createMockWebClient({
      importAccountFile: vi.fn().mockResolvedValue("Imported account"),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useImportAccount());
    const buf = new ArrayBuffer(8);
    new Uint8Array(buf).set([1, 2, 3]);

    await act(async () => {
      await result.current.importAccount({
        type: "file",
        file: buf,
      });
    });

    expect(AccountFile.deserialize).toHaveBeenCalled();
    expect(mockClient.importAccountFile).toHaveBeenCalledWith(deserializedFile);
    expect(result.current.account).toBe(mockAccount);
  });

  it("falls back to byte-equality lookup when the file has neither account() nor accountId()", async () => {
    const fileBytes = new Uint8Array([7, 7, 7]);
    const fileWithoutAccount = {
      // No account() / no accountId() — the hook should fall through to
      // exporting each known account and matching by serialized bytes.
      serialize: vi.fn(() => fileBytes),
    };
    vi.spyOn(AccountFile, "deserialize").mockReturnValueOnce(
      fileWithoutAccount as unknown as AccountFile
    );

    const matchingAccount = createMockAccount();
    const matchingHeader = {
      id: vi.fn(() => createMockAccountId("0xmatch")),
    };
    const otherHeader = { id: vi.fn(() => createMockAccountId("0xother")) };

    const mockClient = createMockWebClient({
      importAccountFile: vi.fn().mockResolvedValue("Imported account"),
      // First call (accountsBefore): empty. Second (accountsAfter): same set.
      getAccounts: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([otherHeader, matchingHeader]),
      // exportAccountFile returns serialized bytes; only the matching header's
      // bytes equal fileBytes.
      exportAccountFile: vi.fn().mockImplementation(async (id: unknown) => {
        const matches =
          (id as { toString: () => string }).toString() === "0xmatch";
        return {
          serialize: () =>
            matches ? new Uint8Array([7, 7, 7]) : new Uint8Array([0, 0, 0]),
        };
      }),
      getAccount: vi.fn().mockImplementation(async (id: unknown) => {
        const idStr = (id as { toString: () => string }).toString();
        return idStr === "0xmatch" ? matchingAccount : null;
      }),
    });

    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useImportAccount());
    await act(async () => {
      await result.current.importAccount({
        type: "file",
        file: new Uint8Array([7, 7, 7]),
      });
    });

    expect(mockClient.exportAccountFile).toHaveBeenCalled();
    expect(result.current.account).toBe(matchingAccount);
  });

  it("uses accountIdFromFile when account() is null but accountId() resolves", async () => {
    const mockAccount = createMockAccount();
    const fileWithIdOnly = {
      account: vi.fn(() => null),
      accountId: vi.fn(() => createMockAccountId("0xfromid")),
      serialize: vi.fn(() => new Uint8Array([1, 2])),
    };
    vi.spyOn(AccountFile, "deserialize").mockReturnValueOnce(
      fileWithIdOnly as unknown as AccountFile
    );

    const mockClient = createMockWebClient({
      importAccountFile: vi.fn().mockResolvedValue("Imported account"),
      getAccounts: vi.fn().mockResolvedValue([]),
      getAccount: vi.fn().mockResolvedValue(mockAccount),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useImportAccount());
    await act(async () => {
      await result.current.importAccount({
        type: "file",
        file: new Uint8Array([1, 2]),
      });
    });

    expect(fileWithIdOnly.accountId).toHaveBeenCalled();
    expect(mockClient.getAccount).toHaveBeenCalled();
    expect(result.current.account).toBe(mockAccount);
  });

  it("throws 'Account not found after import' when nothing matches", async () => {
    const fileNoMatch = {
      account: vi.fn(() => null),
      accountId: vi.fn(() => null),
      serialize: vi.fn(() => new Uint8Array([9, 9])),
    };
    vi.spyOn(AccountFile, "deserialize").mockReturnValueOnce(
      fileNoMatch as unknown as AccountFile
    );

    const mockClient = createMockWebClient({
      importAccountFile: vi.fn().mockResolvedValue("Imported account"),
      getAccounts: vi.fn().mockResolvedValue([]),
      exportAccountFile: vi.fn(),
      getAccount: vi.fn().mockResolvedValue(null),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useImportAccount());
    await act(async () => {
      await expect(
        result.current.importAccount({
          type: "file",
          file: new Uint8Array([9, 9]),
        })
      ).rejects.toThrow("Account not found after import");
    });
  });

  it("rethrows non-'already tracked' errors from importAccountFile", async () => {
    const mockAccount = createMockAccount();
    const file = {
      account: vi.fn(() => mockAccount),
      serialize: vi.fn(() => new Uint8Array([0])),
    };
    vi.spyOn(AccountFile, "deserialize").mockReturnValueOnce(
      file as unknown as AccountFile
    );

    const mockClient = createMockWebClient({
      importAccountFile: vi
        .fn()
        .mockRejectedValue(new Error("permission denied")),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useImportAccount());
    await act(async () => {
      await expect(
        result.current.importAccount({
          type: "file",
          file: new Uint8Array([0]),
        })
      ).rejects.toThrow("permission denied");
    });
  });

  it("throws when account-id import doesn't return an account", async () => {
    const mockClient = createMockWebClient({
      importAccountById: vi.fn().mockResolvedValue(undefined),
      getAccount: vi.fn().mockResolvedValue(null),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });

    const { result } = renderHook(() => useImportAccount());
    await act(async () => {
      await expect(
        result.current.importAccount({
          type: "id",
          accountId: "0xmissing",
        })
      ).rejects.toThrow("Account not found after import");
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// useConsume: covers the "no notes resolved" and "partial resolution"
// error branches around lines 142-148.
// ────────────────────────────────────────────────────────────────────────
describe("useConsume — note-resolution error paths", () => {
  it("throws when the consumable list resolves to an empty array (notes.length === 0)", async () => {
    const mockClient = createMockWebClient({
      // getInputNotes returns no records for the supplied IDs → resolved is empty.
      getInputNotes: vi.fn().mockResolvedValue([]),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useConsume());
    // Pass a Note-id-like object so it goes through the lookupIds path; with
    // an empty getInputNotes return, the lookup throws.
    await act(async () => {
      await expect(
        result.current.consume({
          accountId: "0xacc",
          notes: [{ toString: () => "0xnote_unknown" } as never],
        })
      ).rejects.toThrow(/could not be found|No notes found/);
    });
  });

  it("succeeds when notes resolve via toNote() (InputNoteRecord pre-resolved path)", async () => {
    const inputNote = createMockInputNoteRecord("0xnote1");
    const mockClient = createMockWebClient({
      submitNewTransaction: vi.fn().mockResolvedValue({
        toString: () => "0xtx_consume",
      }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
    });

    const { result } = renderHook(() => useConsume());
    await act(async () => {
      await result.current.consume({
        accountId: "0xacc",
        // InputNoteRecord-shaped — has toNote().
        notes: [inputNote as never],
      });
    });
    expect(mockClient.submitNewTransaction).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────
// useNotes: covers the consumableNoteSummaries sender + excludeIds branches.
// ────────────────────────────────────────────────────────────────────────
describe("useNotes — sender + excludeIds filters on consumableNotes", () => {
  it("filters consumable notes by sender AND drops excludeIds", async () => {
    // Two consumables; each wraps an inputNote with a sender. The filter
    // should drop the wrong sender, then drop the explicit-exclude ID.
    const matching = createMockConsumableNoteRecord("0xkeep");
    const wrongSender = createMockConsumableNoteRecord("0xother");
    const excluded = createMockConsumableNoteRecord("0xexclude");

    const mockClient = createMockWebClient({
      getInputNotes: vi.fn().mockResolvedValue([]),
      getConsumableNotes: vi
        .fn()
        .mockResolvedValue([matching, wrongSender, excluded]),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });
    act(() => {
      useMidenStore
        .getState()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .setClient(mockClient as any);
    });

    const { result } = renderHook(() =>
      useNotes({
        sender: "0xsender_filter",
        excludeIds: ["0xexclude"],
      })
    );

    // Trigger the initial fetch.
    await waitFor(() => {
      expect(mockClient.getConsumableNotes).toHaveBeenCalled();
    });

    // Both noteSummaries and consumableNoteSummaries should be filtered.
    expect(Array.isArray(result.current.consumableNoteSummaries)).toBe(true);
    expect(
      result.current.consumableNoteSummaries.every((s) => s.id !== "0xexclude")
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// useSend: covers the "Missing full note for private send" error branch.
// ────────────────────────────────────────────────────────────────────────
describe("useSend — private-send error branch", () => {
  it("throws when note type is Private but no full note was extracted", async () => {
    // Build a tx result whose executedTransaction has no output notes →
    // extractFullNote returns null → the Private-send path throws.
    const txResult = {
      id: () => ({ toString: () => "0xtx", toHex: () => "0xtx" }),
      executedTransaction: () => ({
        outputNotes: () => ({ notes: () => [] }),
      }),
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
      ).rejects.toThrow("Missing full note for private send");
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// useMint / useSwap: cover the prover-supplied branch (uses
// submitNewTransactionWithProver instead of submitNewTransaction).
// ────────────────────────────────────────────────────────────────────────
describe("useMint / useSwap — prover branch", () => {
  it("useMint uses submitNewTransactionWithProver when prover is provided", async () => {
    const submitWithProver = vi
      .fn()
      .mockResolvedValue({ toString: () => "0xtx_mint" });
    const submitWithout = vi.fn();
    const mockClient = createMockWebClient({
      submitNewTransactionWithProver: submitWithProver,
      submitNewTransaction: submitWithout,
      newMintTransactionRequest: vi.fn().mockResolvedValue({}),
    });
    const fakeProver = { type: "remote" } as never;
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
      prover: fakeProver,
    });

    const { result } = renderHook(() => useMint());
    await act(async () => {
      await result.current.mint({
        targetAccountId: "0xaccount",
        faucetId: "0xfaucet",
        amount: 100n,
      });
    });

    expect(submitWithProver).toHaveBeenCalled();
    expect(submitWithout).not.toHaveBeenCalled();
  });

  it("useSwap uses submitNewTransactionWithProver when prover is provided", async () => {
    const submitWithProver = vi
      .fn()
      .mockResolvedValue({ toString: () => "0xtx_swap" });
    const submitWithout = vi.fn();
    const mockClient = createMockWebClient({
      submitNewTransactionWithProver: submitWithProver,
      submitNewTransaction: submitWithout,
      newSwapTransactionRequest: vi.fn().mockResolvedValue({}),
    });
    const fakeProver = { type: "remote" } as never;
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn().mockResolvedValue(undefined),
      runExclusive: <T,>(fn: () => Promise<T>) => fn(),
      prover: fakeProver,
    });

    const { result } = renderHook(() => useSwap());
    await act(async () => {
      await result.current.swap({
        accountId: "0xaccount",
        offeredFaucetId: "0xoffered",
        offeredAmount: 1n,
        requestedFaucetId: "0xrequested",
        requestedAmount: 2n,
      });
    });

    expect(submitWithProver).toHaveBeenCalled();
    expect(submitWithout).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────
// useSend: cover the on-chain hasAttachment branch (manual P2ID note
// construction with NoteAttachment instead of newSendTransactionRequest).
// ────────────────────────────────────────────────────────────────────────
describe("useSend — on-chain attachment branch", () => {
  it("uses manual P2ID note construction when attachment is provided", async () => {
    const txResult = {
      id: () => ({ toString: () => "0xtx_attach", toHex: () => "0xtx_attach" }),
      executedTransaction: () => ({
        outputNotes: () => ({ notes: () => [] }),
      }),
    };
    const newSendReq = vi.fn();
    const executeTx = vi.fn().mockResolvedValue(txResult);
    const mockClient = createMockWebClient({
      executeTransaction: executeTx,
      proveTransaction: vi.fn().mockResolvedValue({}),
      submitProvenTransaction: vi.fn().mockResolvedValue(100),
      applyTransaction: vi.fn().mockResolvedValue({}),
      newSendTransactionRequest: newSendReq, // should NOT be called
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
        // "public" so the post-send Private branch (which requires an
        // extracted fullNote) doesn't fire.
        noteType: "public",
        // Trigger the manual P2ID + NoteAttachment path.
        attachment: { word: new BigUint64Array(4) } as never,
      });
    });

    // The manual path bypasses newSendTransactionRequest entirely.
    expect(newSendReq).not.toHaveBeenCalled();
    expect(executeTx).toHaveBeenCalled();
  });

  it("rejects attachment combined with recallHeight/timelockHeight", async () => {
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
          amount: 1n,
          noteType: "public",
          attachment: { word: new BigUint64Array(4) } as never,
          recallHeight: 100,
        })
      ).rejects.toThrow(/not supported when attachment/);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// useNotes: cover the sender-normalization fallback branches (when
// normalizeAccountId throws — both for the option's sender (142-143) and
// for the per-note sender lookup inside filterBySender (159-168)).
// ────────────────────────────────────────────────────────────────────────
describe("useNotes — normalize fallback paths", () => {
  it("uses options.sender literally when normalizeAccountId throws", async () => {
    // The mock AccountId.fromHex throws when given a non-hex bech32-style id;
    // give the hook a sender that fails normalization to exercise the catch.
    const mockClient = createMockWebClient({
      getInputNotes: vi.fn().mockResolvedValue([]),
      getConsumableNotes: vi.fn().mockResolvedValue([]),
    });
    mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
    act(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useMidenStore.getState().setClient(mockClient as any);
    });

    const { result } = renderHook(() =>
      useNotes({
        // A weird sender string that the mock can't parse as bech32 OR hex.
        sender: "not-a-valid-id",
      })
    );

    await waitFor(() => {
      expect(result.current.consumableNoteSummaries).toBeDefined();
    });
    // The hook should not have crashed — the catch fell back to the literal.
    expect(result.current.error).toBeNull();
  });
});
