import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWaitForNotes } from "../../hooks/useWaitForNotes";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockConsumableNoteRecord,
  createMockWebClient,
} from "../mocks/miden-sdk";

// Mock useMiden
vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

describe("useWaitForNotes", () => {
  it("should throw when client is not ready", async () => {
    mockUseMiden.mockReturnValue({
      client: null,
      isReady: false,
    });

    const { result } = renderHook(() => useWaitForNotes());

    await expect(
      result.current.waitForConsumableNotes({
        accountId: "0xaccount",
      })
    ).rejects.toThrow("Miden client is not ready");
  });

  it("should throw timeout when no consumable notes within timeoutMs (line 52)", async () => {
    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      getConsumableNotes: vi.fn().mockResolvedValue([]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useWaitForNotes());

    await expect(
      result.current.waitForConsumableNotes({
        accountId: "0xaccount",
        timeoutMs: 5,
        intervalMs: 1,
      })
    ).rejects.toThrow("Timeout waiting for consumable notes");
  });

  it("should resolve when consumable notes are available", async () => {
    const note = createMockConsumableNoteRecord("0xnote1");
    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      getConsumableNotes: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([note]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useWaitForNotes());

    const notes = await result.current.waitForConsumableNotes({
      accountId: "0xaccount",
      timeoutMs: 20,
      intervalMs: 1,
    });

    expect(notes).toHaveLength(1);
  });

  it("should use default timeoutMs/intervalMs/minCount when not provided (lines 30-32)", async () => {
    // Immediately return a note so the loop exits on first iteration
    const note = createMockConsumableNoteRecord("0xnote_default");
    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      getConsumableNotes: vi.fn().mockResolvedValue([note]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useWaitForNotes());

    // Pass accountId only — uses defaults (timeoutMs=10000, intervalMs=1000, minCount=1)
    const notes = await result.current.waitForConsumableNotes({
      accountId: "0xaccount",
    });

    expect(notes).toHaveLength(1);
    expect(mockClient.syncState).toHaveBeenCalledTimes(1);
    expect(mockClient.getConsumableNotes).toHaveBeenCalledTimes(1);
  });
});
