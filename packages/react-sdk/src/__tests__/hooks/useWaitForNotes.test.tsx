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

  it("keeps waiting while the only note is block-locked", async () => {
    // The caller asked for notes it can use; a note that unlocks later is not
    // one, so waiting is the right answer rather than returning it.
    const locked = createMockConsumableNoteRecord(
      "0xlocked",
      "0xaccount",
      false
    );
    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      getConsumableNotes: vi.fn().mockResolvedValue([locked]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useWaitForNotes());

    // The timeout message specifically: any other error (e.g. reading an
    // AccountId the binding already consumed) would also satisfy a bare throw.
    await expect(
      result.current.waitForConsumableNotes({
        accountId: "0xaccount",
        timeoutMs: 100,
        intervalMs: 1,
      })
    ).rejects.toThrow("Timeout waiting for consumable notes");
    // One AccountId per poll, since getConsumableNotes takes it by value.
    const calls = (mockClient.getConsumableNotes as ReturnType<typeof vi.fn>)
      .mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]?.[0]).not.toBe(calls[1]?.[0]);
  });

  it("gives up at the timeout, not a full interval later", async () => {
    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      getConsumableNotes: vi.fn().mockResolvedValue([]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useWaitForNotes());

    const start = Date.now();
    await expect(
      result.current.waitForConsumableNotes({
        accountId: "0xaccount",
        timeoutMs: 50,
        intervalMs: 5000,
      })
    ).rejects.toThrow("Timeout waiting for consumable notes");
    expect(Date.now() - start).toBeLessThan(1000);
  }, 10000);

  it("counts time spent syncing toward timeoutMs", async () => {
    const mockClient = createMockWebClient({
      syncState: vi
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 40))
        ),
      getConsumableNotes: vi.fn().mockResolvedValue([]),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useWaitForNotes());

    const start = Date.now();
    await expect(
      result.current.waitForConsumableNotes({
        accountId: "0xaccount",
        timeoutMs: 50,
        intervalMs: 5,
      })
    ).rejects.toThrow("Timeout waiting for consumable notes");
    expect(Date.now() - start).toBeLessThan(300);
  }, 10000);

  it("should resolve when consumable notes are available", async () => {
    const note = createMockConsumableNoteRecord("0xnote1", "0xaccount");
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
      timeoutMs: 200,
      intervalMs: 1,
    });

    expect(notes).toHaveLength(1);
  });
});
