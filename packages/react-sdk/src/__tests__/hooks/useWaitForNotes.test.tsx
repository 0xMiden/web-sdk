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

  it("rebuilds the AccountId per poll so a multi-poll wait does not reuse a moved handle", async () => {
    const note = createMockConsumableNoteRecord("0xnote1");

    // `getConsumableNotes` takes `Option<AccountId>` by value on the WASM
    // surface (crates/web-client/src/notes.rs), so wasm-bindgen moves the
    // handle out of JS on every call. Mirror that here: the first call
    // consumes the handle, any later call against the same one traps.
    const seen: unknown[] = [];
    let poll = 0;
    const mockClient = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      getConsumableNotes: vi.fn(async (accountId: { _live?: boolean }) => {
        if (accountId?._live === false) {
          throw new Error("null pointer passed to rust");
        }
        if (accountId && typeof accountId === "object") {
          accountId._live = false;
        }
        seen.push(accountId);
        return poll++ === 0 ? [] : [note];
      }),
    });

    mockUseMiden.mockReturnValue({
      client: mockClient,
      isReady: true,
    });

    const { result } = renderHook(() => useWaitForNotes());

    const notes = await result.current.waitForConsumableNotes({
      accountId: "0xaccount",
      timeoutMs: 50,
      intervalMs: 1,
    });

    expect(notes).toHaveLength(1);
    // A fresh handle per poll, not the same object reused.
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
