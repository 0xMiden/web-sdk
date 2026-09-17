import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCreateNetworkNote } from "../../hooks/useCreateNetworkNote";
import { useMiden } from "../../context/MidenProvider";
import { createMockWebClient } from "../mocks/miden-sdk";
import { FeltArray } from "@miden-sdk/miden-sdk";
import type { NoteScript, NoteRecipient } from "@miden-sdk/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({ useMiden: vi.fn() }));
const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

// Mock WASM classes are plain objects at test time; the real `NoteScript` /
// `NoteRecipient` classes only matter to the (mocked) SDK internals here, so
// casting a stub object is the standard way this codebase feeds WASM-typed
// option fields into hook tests.
const mockScript = {} as unknown as NoteScript;
const mockRecipient = {} as unknown as NoteRecipient;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useCreateNetworkNote", () => {
  it("returns initial state", () => {
    mockUseMiden.mockReturnValue({
      client: null,
      isReady: false,
      sync: vi.fn(),
    });
    const { result } = renderHook(() => useCreateNetworkNote());
    expect(result.current.result).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.stage).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(typeof result.current.createNetworkNote).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });

  it("throws when client is not ready", async () => {
    mockUseMiden.mockReturnValue({
      client: null,
      isReady: false,
      sync: vi.fn(),
    });
    const { result } = renderHook(() => useCreateNetworkNote());
    await expect(
      result.current.createNetworkNote({
        accountId: "0xs",
        target: "0xt",
        script: mockScript,
      })
    ).rejects.toThrow("Miden client is not ready");
  });

  it("throws when both recipient and script are provided", async () => {
    mockUseMiden.mockReturnValue({
      client: createMockWebClient(),
      isReady: true,
      sync: vi.fn(),
    });
    const { result } = renderHook(() => useCreateNetworkNote());
    await expect(
      result.current.createNetworkNote({
        accountId: "0xs",
        target: "0xt",
        script: mockScript,
        recipient: mockRecipient,
      })
    ).rejects.toThrow(
      "createNetworkNote requires exactly one of `recipient` or `script`, not both."
    );
  });

  it("throws when neither recipient nor script is provided", async () => {
    mockUseMiden.mockReturnValue({
      client: createMockWebClient(),
      isReady: true,
      sync: vi.fn(),
    });
    const { result } = renderHook(() => useCreateNetworkNote());
    await expect(
      result.current.createNetworkNote({ accountId: "0xs", target: "0xt" })
    ).rejects.toThrow(
      "createNetworkNote requires either `recipient` or `script`."
    );
  });

  it("builds + submits a network note and returns { txId, note }", async () => {
    const mockSync = vi.fn().mockResolvedValue(undefined);
    const mockClient = createMockWebClient({
      submitNewTransaction: vi.fn().mockResolvedValue({ toHex: () => "0xtx" }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: mockSync,
    });

    const { result } = renderHook(() => useCreateNetworkNote());
    let out: any;
    await act(async () => {
      out = await result.current.createNetworkNote({
        accountId: "0xsender",
        target: "0xnetwork",
        script: mockScript,
      });
    });

    expect(out.txId).toBe("0xtx");
    expect(mockClient.submitNewTransaction).toHaveBeenCalled();
    expect(result.current.stage).toBe("complete");
    expect(mockSync).toHaveBeenCalled();

    // The request must come from a fee-aware builder, for the sender — a bare
    // `new TransactionRequestBuilder()` aborts with
    // ERR_FEE_CONVERSION_INFO_MISSING wherever the chain charges a fee.
    expect(mockClient.feeAwareTransactionRequestBuilder).toHaveBeenCalledTimes(
      1
    );
    const [executingAccount] =
      mockClient.feeAwareTransactionRequestBuilder.mock.calls[0];
    expect((executingAccount as { toString(): string }).toString()).toBe(
      "0xsender"
    );
  });

  it("builds a note from a provided recipient (no script)", async () => {
    const mockClient = createMockWebClient({
      submitNewTransaction: vi.fn().mockResolvedValue({ toHex: () => "0xtx" }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });

    const { result } = renderHook(() => useCreateNetworkNote());
    let out: any;
    await act(async () => {
      out = await result.current.createNetworkNote({
        accountId: "0xsender",
        target: "0xnetwork",
        recipient: mockRecipient,
      });
    });

    expect(out.txId).toBe("0xtx");
    expect(mockClient.submitNewTransaction).toHaveBeenCalled();
  });

  it("includes a single asset when assetId + amount are provided", async () => {
    const mockClient = createMockWebClient({
      submitNewTransaction: vi.fn().mockResolvedValue({ toHex: () => "0xtx" }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });

    const { result } = renderHook(() => useCreateNetworkNote());
    await act(async () => {
      await result.current.createNetworkNote({
        accountId: "0xsender",
        target: "0xnetwork",
        script: mockScript,
        assetId: "0xfaucet",
        amount: 100n,
      });
    });

    expect(mockClient.submitNewTransaction).toHaveBeenCalled();
  });

  it("defaults amount to 0 when assetId is provided without an amount", async () => {
    const mockClient = createMockWebClient({
      submitNewTransaction: vi.fn().mockResolvedValue({ toHex: () => "0xtx" }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });

    const { result } = renderHook(() => useCreateNetworkNote());
    await act(async () => {
      await result.current.createNetworkNote({
        accountId: "0xsender",
        target: "0xnetwork",
        script: mockScript,
        assetId: "0xfaucet",
      });
    });

    expect(mockClient.submitNewTransaction).toHaveBeenCalled();
  });

  it("appends an extra attachment when provided", async () => {
    const mockClient = createMockWebClient({
      submitNewTransaction: vi.fn().mockResolvedValue({ toHex: () => "0xtx" }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });

    const { result } = renderHook(() => useCreateNetworkNote());
    await act(async () => {
      await result.current.createNetworkNote({
        accountId: "0xsender",
        target: "0xnetwork",
        script: mockScript,
        attachment: [1n, 2n, 3n, 4n],
      });
    });

    expect(mockClient.submitNewTransaction).toHaveBeenCalled();
  });

  it("wraps `inputs` into a FeltArray of Felt values for NoteStorage", async () => {
    const mockClient = createMockWebClient({
      submitNewTransaction: vi.fn().mockResolvedValue({ toHex: () => "0xtx" }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });

    const { result } = renderHook(() => useCreateNetworkNote());
    await act(async () => {
      await result.current.createNetworkNote({
        accountId: "0xsender",
        target: "0xnetwork",
        script: mockScript,
        inputs: [1n, 2n, 3n],
      });
    });

    expect(FeltArray).toHaveBeenCalled();
    const passedElements = (FeltArray as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Array<{
      asInt: () => bigint;
    }>;
    expect(passedElements.map((felt) => felt.asInt())).toEqual([1n, 2n, 3n]);
  });

  it("submits via the prover when one is configured", async () => {
    const mockClient = createMockWebClient({
      submitNewTransactionWithProver: vi
        .fn()
        .mockResolvedValue({ toHex: () => "0xtx-proved" }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
      prover: { type: "local" },
    });

    const { result } = renderHook(() => useCreateNetworkNote());
    let out: any;
    await act(async () => {
      out = await result.current.createNetworkNote({
        accountId: "0xsender",
        target: "0xnetwork",
        script: mockScript,
      });
    });

    expect(out.txId).toBe("0xtx-proved");
    expect(mockClient.submitNewTransactionWithProver).toHaveBeenCalled();
    expect(mockClient.submitNewTransaction).not.toHaveBeenCalled();
  });

  it("surfaces submit errors and resets stage to idle", async () => {
    const mockClient = createMockWebClient({
      submitNewTransaction: vi.fn().mockRejectedValue(new Error("boom")),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });
    const { result } = renderHook(() => useCreateNetworkNote());
    await act(async () => {
      await expect(
        result.current.createNetworkNote({
          accountId: "0x1",
          target: "0x2",
          script: mockScript,
        })
      ).rejects.toThrow("boom");
    });
    await waitFor(() => expect(result.current.error?.message).toBe("boom"));
    expect(result.current.stage).toBe("idle");
  });

  it("wraps a non-Error rejection into an Error", async () => {
    const mockClient = createMockWebClient({
      submitNewTransaction: vi.fn().mockRejectedValue("string-failure"),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });
    const { result } = renderHook(() => useCreateNetworkNote());
    await act(async () => {
      await expect(
        result.current.createNetworkNote({
          accountId: "0x1",
          target: "0x2",
          script: mockScript,
        })
      ).rejects.toThrow("string-failure");
    });
    await waitFor(() =>
      expect(result.current.error?.message).toBe("string-failure")
    );
    expect(result.current.stage).toBe("idle");
  });

  it("reset() clears result, error, and stage back to idle", async () => {
    const mockClient = createMockWebClient({
      submitNewTransaction: vi.fn().mockResolvedValue({ toHex: () => "0xtx" }),
    });
    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
      sync: vi.fn(),
    });
    const { result } = renderHook(() => useCreateNetworkNote());

    await act(async () => {
      await result.current.createNetworkNote({
        accountId: "0xsender",
        target: "0xnetwork",
        script: mockScript,
      });
    });
    expect(result.current.result).not.toBeNull();

    act(() => {
      result.current.reset();
    });

    expect(result.current.result).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.stage).toBe("idle");
    expect(result.current.error).toBeNull();
  });
});
