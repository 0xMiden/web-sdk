import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { TransactionFilter, TransactionId } from "@miden-sdk/miden-sdk";
import { useTransactionHistory } from "../../hooks/useTransactionHistory";
import { useWaitForCommit } from "../../hooks/useWaitForCommit";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import { createMockWebClient } from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({ useMiden: vi.fn() }));
const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

type Movable = { _live?: boolean };

/**
 * `TransactionFilter::ids` takes `Vec<TransactionId>` by value, so the
 * generated glue calls `__destroy_into_raw()` on each id and zeroes the JS
 * wrapper's pointer. The default mock in setup.ts returns a plain object and
 * models none of that — which is exactly why the existing suite stayed green
 * while the reuse bugs shipped. Install a mock that does model it.
 */
function installMovingTransactionFilterIds() {
  vi.mocked(TransactionFilter.ids).mockImplementation((ids: unknown) => {
    const list = ids as Movable[];
    for (const id of list) {
      if (id?._live === false) {
        throw new Error("null pointer passed to rust");
      }
    }
    for (const id of list) {
      if (id && typeof id === "object") id._live = false;
    }
    return { ids } as never;
  });
}

const makeTxId = (hex: string) => ({
  toHex: () => hex,
  toString: () => hex,
  free: vi.fn(),
});

const makeRecord = (hex: string, committed: boolean) => ({
  id: () => ({ toHex: () => hex }),
  transactionStatus: () => ({
    isPending: () => !committed,
    isCommitted: () => committed,
    isDiscarded: () => false,
  }),
});

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
  vi.mocked(TransactionId.fromHex).mockImplementation(
    (hex: string) => makeTxId(hex) as never
  );
  installMovingTransactionFilterIds();
});

describe("#278 — by-value WASM objects must not be reused across iterations", () => {
  it("useTransactionHistory rebuilds TransactionIds on every refetch", async () => {
    const txId = makeTxId("0xtx1");
    const client = createMockWebClient({
      getTransactions: vi.fn().mockResolvedValue([makeRecord("0xtx1", true)]),
    });
    mockUseMiden.mockReturnValue({ client, isReady: true });
    act(() => {
      useMidenStore.getState().setClient(client as never);
    });

    // Hold the options object stable across renders (an inline literal would
    // change `options.ids`' identity every render and re-trigger the fetch
    // effect on its own, which is a separate concern from what this asserts).
    const options = { ids: [txId as never] };

    // `ids` is memoised by the hook, so without the fix the very same
    // TransactionId object is handed to TransactionFilter.ids again on the
    // next refetch.
    const { result } = renderHook(() => useTransactionHistory(options));
    await waitFor(() =>
      expect(
        (client.getTransactions as ReturnType<typeof vi.fn>).mock.calls.length
      ).toBe(1)
    );

    // A sync tick drives a second refetch.
    act(() => {
      useMidenStore.getState().setSyncState({ lastSyncTime: Date.now() });
    });

    await waitFor(() =>
      expect(
        (client.getTransactions as ReturnType<typeof vi.fn>).mock.calls.length
      ).toBe(2)
    );
    expect(result.current.error).toBeNull();
  });

  it("useWaitForCommit rebuilds the TransactionId on every poll", async () => {
    const txId = makeTxId("0xtx2");
    const client = createMockWebClient({
      syncState: vi.fn().mockResolvedValue({}),
      getTransactions: vi
        .fn()
        .mockResolvedValueOnce([makeRecord("0xtx2", false)])
        .mockResolvedValue([makeRecord("0xtx2", true)]),
    });
    mockUseMiden.mockReturnValue({ client, isReady: true });

    const { result } = renderHook(() => useWaitForCommit());

    await expect(
      result.current.waitForCommit(txId as never, {
        timeoutMs: 200,
        intervalMs: 1,
      })
    ).resolves.toBeUndefined();

    expect(
      (client.getTransactions as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBeGreaterThan(1);
  });
});
