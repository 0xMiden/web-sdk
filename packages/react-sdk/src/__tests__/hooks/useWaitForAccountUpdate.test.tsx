import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Word } from "@miden-sdk/miden-sdk";
import { useWaitForAccountUpdate } from "../../hooks/useWaitForAccountUpdate";
import { useMiden } from "../../context/MidenProvider";
import { useMidenStore } from "../../store/MidenStore";
import {
  createMockWebClient,
  createMockAccount,
  createMockAccountId,
  createMockAccountHeader,
} from "../mocks/miden-sdk";

vi.mock("../../context/MidenProvider", () => ({
  useMiden: vi.fn(),
}));

const mockUseMiden = useMiden as ReturnType<typeof vi.fn>;

function createWord(hex: string) {
  return {
    free: vi.fn(),
    toHex: vi.fn(() => hex),
    serialize: vi.fn(() => new Uint8Array()),
    toU64s: vi.fn(() => new BigUint64Array([0n, 0n, 0n, 0n])),
    toFelts: vi.fn(() => []),
    [Symbol.dispose]: vi.fn(),
  };
}

function createAccountWithCommitment(
  commitmentHex: string,
  storageOverrides: Record<string, unknown> = {}
) {
  return createMockAccount({
    // eslint-disable-next-line camelcase
    to_commitment: vi.fn(() => createWord(commitmentHex)),
    storage: vi.fn(() => storageOverrides),
  } as never);
}

beforeEach(() => {
  useMidenStore.getState().reset();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useWaitForAccountUpdate", () => {
  describe("readiness and input validation", () => {
    it("rejects when client is not ready", async () => {
      mockUseMiden.mockReturnValue({ client: null, isReady: false });

      const { result } = renderHook(() => useWaitForAccountUpdate());

      await expect(
        result.current.waitForAccountUpdate({ accountId: "0xacc" })
      ).rejects.toThrow("Miden client is not ready");
      expect(result.current.isWaiting).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("rejects when client exists but isReady is false", async () => {
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: false });

      const { result } = renderHook(() => useWaitForAccountUpdate());

      await expect(
        result.current.waitForAccountUpdate("0xacc")
      ).rejects.toThrow("Miden client is not ready");
      expect(mockClient.syncState).not.toHaveBeenCalled();
    });

    it("rejects when accountId is omitted or blank", async () => {
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      await expect(result.current.waitForAccountUpdate()).rejects.toThrow(
        "Account ID is required"
      );
      await expect(
        result.current.waitForAccountUpdate({ accountId: "   " })
      ).rejects.toThrow("Account ID is required");
      expect(mockClient.syncState).not.toHaveBeenCalled();
    });

    it("rejects when mapKey is specified without slot", async () => {
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      await expect(
        result.current.waitForAccountUpdate({
          accountId: "0xacc",
          mapKey: "0xkey",
        })
      ).rejects.toThrow(
        "Storage slot name is required when mapKey is specified"
      );
      expect(mockClient.syncState).not.toHaveBeenCalled();
    });

    it("routes syncState and getAccount through runExclusive and refreshes AccountId per poll", async () => {
      const runExclusive = vi.fn(<T,>(fn: () => Promise<T>) => fn());
      const account1 = createAccountWithCommitment("0xcommit1");
      const account2 = createAccountWithCommitment("0xcommit2");
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(account1)
          .mockResolvedValueOnce(account2),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        runExclusive,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const accountIdObj = createMockAccountId("0xacc");
      const { result } = renderHook(() => useWaitForAccountUpdate());

      let resolved: unknown;
      await act(async () => {
        resolved = await result.current.waitForAccountUpdate(
          accountIdObj as never,
          {
            baselineCommitment: "0xcommit1",
            timeoutMs: 500,
            intervalMs: 1,
          }
        );
      });

      expect(resolved).toBe(account2);
      expect(runExclusive).toHaveBeenCalledTimes(4);
      const calls = (mockClient.getAccount as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[0]).not.toBe(calls[1]?.[0]);
    });

    it("accepts AccountHeader as accountId", async () => {
      const updated = createAccountWithCommitment("0xnew");
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi.fn().mockResolvedValue(updated),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const header = createMockAccountHeader("0xheaderacc");
      const { result } = renderHook(() => useWaitForAccountUpdate());

      let resolved: unknown;
      await act(async () => {
        resolved = await result.current.waitForAccountUpdate(header as never, {
          baselineCommitment: "0xold",
          timeoutMs: 200,
          intervalMs: 1,
        });
      });

      expect(resolved).toBe(updated);
    });
  });

  describe("commitment updates", () => {
    it("resolves immediately on first poll when commitment already differs from baselineCommitment", async () => {
      const updated = createAccountWithCommitment("0xcommit_after");
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi.fn().mockResolvedValue(updated),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() =>
        useWaitForAccountUpdate("0xacc", {
          baselineCommitment: createWord("0xCOMMIT_BEFORE") as unknown as Word,
          timeoutMs: 500,
          intervalMs: 50,
        })
      );

      let resolved: unknown;
      await act(async () => {
        resolved = await result.current.waitForAccountUpdate();
      });

      expect(resolved).toBe(updated);
      expect(mockClient.syncState).toHaveBeenCalledTimes(1);
      expect(result.current.account).toBe(updated);
      expect(result.current.isWaiting).toBe(false);
      expect(result.current.error).toBeNull();
      expect(useMidenStore.getState().accountDetails.get("0xacc")).toBe(
        updated
      );
    });

    it("polls until account commitment changes past baselineCommitment", async () => {
      vi.useFakeTimers();
      const unchanged = createAccountWithCommitment("0xbase");
      const changed = createAccountWithCommitment("0xnext");
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(unchanged)
          .mockResolvedValueOnce(unchanged)
          .mockResolvedValueOnce(changed),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      let settled: unknown;
      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current
          .waitForAccountUpdate({
            accountId: "0xacc",
            baselineCommitment: "0xbase",
            timeoutMs: 1000,
            intervalMs: 100,
          })
          .then((acc) => {
            settled = acc;
            return acc;
          });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      await pending;

      expect(settled).toBe(changed);
      expect(mockClient.syncState).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("captures initial snapshot as baseline when baselineCommitment is omitted", async () => {
      vi.useFakeTimers();
      const initial = createAccountWithCommitment("0xsame");
      const updated = createAccountWithCommitment("0xchanged");
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(initial)
          .mockResolvedValueOnce(initial)
          .mockResolvedValueOnce(updated),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current.waitForAccountUpdate("0xacc", {
          timeoutMs: 1000,
          intervalMs: 50,
        });
      });

      // After poll 1, initial snapshot was captured so it must still be waiting
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.isWaiting).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(110);
      });

      await expect(pending).resolves.toBe(updated);
      expect(mockClient.syncState).toHaveBeenCalledTimes(3);
    });
  });

  describe("storage slot and mapKey updates", () => {
    it("resolves when storage slot commitment changes (ignoring unchanged target slot)", async () => {
      vi.useFakeTimers();
      // Account commitment changes on poll 2, but watched slot stays the same until poll 3
      const acc1 = createAccountWithCommitment("0xcomm1", {
        getCommitment: vi.fn(() => createWord("0xslot_v1")),
      });
      const acc2 = createAccountWithCommitment("0xcomm2", {
        getCommitment: vi.fn(() => createWord("0xslot_v1")),
      });
      const acc3 = createAccountWithCommitment("0xcomm3", {
        getCommitment: vi.fn(() => createWord("0xslot_v2")),
      });

      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(acc1)
          .mockResolvedValueOnce(acc2)
          .mockResolvedValueOnce(acc3),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current.waitForAccountUpdate("0xacc", {
          slot: "counter::value",
          timeoutMs: 1000,
          intervalMs: 50,
        });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(120);
      });

      await expect(pending).resolves.toBe(acc3);
      expect(mockClient.syncState).toHaveBeenCalledTimes(3);
    });

    it("falls back to storage.getItem when getCommitment is unavailable (including StorageMap entries)", async () => {
      vi.useFakeTimers();
      // First entry stays identical, second entry changes -> must still detect update!
      const acc1 = createAccountWithCommitment("0xcomm1", {
        getItem: vi.fn(() => ({
          isMap: true,
          entries: [
            { key: "0xk1", value: "0xv1" },
            { key: "0xk2", value: "0xv2" },
          ],
        })),
      });
      const acc2 = createAccountWithCommitment("0xcomm2", {
        getItem: vi.fn(() => ({
          isMap: true,
          entries: [
            { key: "0xk1", value: "0xv1" },
            { key: "0xk2", value: "0xv2_updated" },
          ],
        })),
      });

      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(acc1)
          .mockResolvedValueOnce(acc2),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current.waitForAccountUpdate({
          accountId: "0xacc",
          slot: "balances",
          timeoutMs: 500,
          intervalMs: 25,
        });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30);
      });

      await expect(pending).resolves.toBe(acc2);
    });

    it("resolves when storage mapKey entry changes from absent to present or to a new Word", async () => {
      vi.useFakeTimers();
      const getMapItem1 = vi.fn(() => undefined);
      const getMapItem2 = vi.fn(() => undefined);
      const getMapItem3 = vi.fn(() => createWord("0xval1"));

      const acc1 = createAccountWithCommitment("0x1", {
        getMapItem: getMapItem1,
      });
      const acc2 = createAccountWithCommitment("0x2", {
        getMapItem: getMapItem2,
      });
      const acc3 = createAccountWithCommitment("0x3", {
        getMapItem: getMapItem3,
      });

      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(acc1)
          .mockResolvedValueOnce(acc2)
          .mockResolvedValueOnce(acc3),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current.waitForAccountUpdate("0xacc", {
          slot: "counter::map",
          mapKey: "0x0000000000000001",
          timeoutMs: 1000,
          intervalMs: 50,
        });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(120);
      });

      await expect(pending).resolves.toBe(acc3);
      expect(Word.fromHex).toHaveBeenCalledWith("0x0000000000000001");
      expect(getMapItem1).toHaveBeenCalledWith(
        "counter::map",
        expect.objectContaining({ toHex: expect.any(Function) })
      );
    });

    it("supports explicit baselineValue (bigint, hex, Word, and null) and storage fallbacks", async () => {
      const storage = {
        getItem: vi
          .fn()
          .mockReturnValueOnce({
            isMap: false,
            toBigInt: vi.fn(() => 2n),
            toHex: vi.fn(() => "0x02"),
          })
          .mockReturnValueOnce({
            toString: vi.fn(() => "0xslot_v2"),
          }),
        getMapItem: vi
          .fn()
          .mockReturnValueOnce(createWord("0xentry"))
          .mockReturnValueOnce({
            toU64s: vi.fn(() => new BigUint64Array([9n, 0n, 0n, 0n])),
          })
          .mockReturnValueOnce(undefined),
      };
      const acc = createAccountWithCommitment("0x1", storage);
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi.fn().mockResolvedValue(acc),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      await act(async () => {
        // 1. Value slot with bigint baselineValue via StorageResult.toBigInt()
        const res1 = await result.current.waitForAccountUpdate("0xacc", {
          slot: "counter::value",
          baselineValue: 1n,
          timeoutMs: 100,
        });
        expect(res1).toBe(acc);

        // 2. Value slot fallback to getItem() without getCommitment() using toString()
        const res2 = await result.current.waitForAccountUpdate("0xacc", {
          slot: "counter::value",
          baselineValue: "0xslot_v1",
          timeoutMs: 100,
        });
        expect(res2).toBe(acc);

        // 3. MapKey with null baselineValue (absent -> present)
        const keyWord = new Word([1n, 0n, 0n, 0n]);
        const res3 = await result.current.waitForAccountUpdate("0xacc", {
          slot: "counter::map",
          mapKey: keyWord,
          baselineValue: null,
          timeoutMs: 100,
        });
        expect(res3).toBe(acc);
        expect(storage.getMapItem).toHaveBeenCalledWith(
          "counter::map",
          keyWord
        );

        // 4. MapKey with bigint baselineValue via Word.toU64s()
        const res4 = await result.current.waitForAccountUpdate("0xacc", {
          slot: "counter::map",
          mapKey: keyWord,
          baselineValue: 5n,
          timeoutMs: 100,
        });
        expect(res4).toBe(acc);

        // 5. MapKey absent when expecting non-null bigint baseline -> resolves immediately
        const res5 = await result.current.waitForAccountUpdate("0xacc", {
          slot: "counter::map",
          mapKey: keyWord,
          baselineValue: 5n,
          timeoutMs: 100,
        });
        expect(res5).toBe(acc);
      });
    });

    it("handles Word-like objects whose toString returns [object Object] cleanly", async () => {
      const opaqueWord = {};
      const updated = createAccountWithCommitment("0xupdated");
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(
            createMockAccount({
              // eslint-disable-next-line camelcase
              to_commitment: vi.fn(() => opaqueWord),
            } as never)
          )
          .mockResolvedValueOnce(updated),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() =>
        useWaitForAccountUpdate("0xacc", {
          baselineValue: createWord("0xunused") as unknown as Word,
          timeoutMs: 200,
          intervalMs: 1,
        })
      );

      let resolved: unknown;
      await act(async () => {
        resolved = await result.current.waitForAccountUpdate({
          timeoutMs: 200,
          intervalMs: 1,
        });
      });
      expect(resolved).toBe(updated);
    });
  });

  describe("timeout handling", () => {
    it("rejects with timeout error at timeoutMs without overrunning by a full interval", async () => {
      const unchanged = createAccountWithCommitment("0xsame");
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi.fn().mockResolvedValue(unchanged),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      const start = Date.now();
      await act(async () => {
        await expect(
          result.current.waitForAccountUpdate("0xacc", {
            baselineCommitment: "0xsame",
            timeoutMs: 50,
            intervalMs: 5000,
          })
        ).rejects.toThrow("Timeout waiting for account update");
      });

      expect(Date.now() - start).toBeLessThan(1000);
      expect(result.current.isWaiting).toBe(false);
      expect(result.current.error?.message).toBe(
        "Timeout waiting for account update"
      );
    }, 10000);

    it("rejects on timeout when account remains null and handles NaN intervalMs/timeoutMs and slow sync", async () => {
      const syncState = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 60))
      );
      const mockClient = createMockWebClient({
        syncState,
        getAccount: vi.fn().mockResolvedValue(null),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      await act(async () => {
        await expect(
          result.current.waitForAccountUpdate("0xacc", {
            timeoutMs: 50,
            intervalMs: Number.NaN,
          })
        ).rejects.toThrow("Timeout waiting for account update");
      });
      expect(syncState).toHaveBeenCalledTimes(1);

      // NaN timeoutMs falls back to 10s default and still resolves immediately when updated
      const updated = createAccountWithCommitment("0xnew");
      mockClient.syncState = vi.fn().mockResolvedValue({});
      mockClient.getAccount = vi.fn().mockResolvedValue(updated);
      await act(async () => {
        const acc = await result.current.waitForAccountUpdate("0xacc", {
          baselineCommitment: "0xold",
          timeoutMs: Number.NaN,
        });
        expect(acc).toBe(updated);
      });
    }, 10000);
  });

  describe("unmount, unsubscribe, reset, and reactive mode", () => {
    it("stops polling and clears all timers on unmount during sleep without rejecting", async () => {
      vi.useFakeTimers();
      const unchanged = createAccountWithCommitment("0xbase");
      const syncState = vi.fn().mockResolvedValue({});
      const getAccount = vi.fn().mockResolvedValue(unchanged);
      const mockClient = createMockWebClient({ syncState, getAccount });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result, unmount } = renderHook(() => useWaitForAccountUpdate());

      act(() => {
        void result.current.waitForAccountUpdate("0xacc", {
          baselineCommitment: "0xbase",
          timeoutMs: 10_000,
          intervalMs: 100,
        });
      });

      await act(async () => {
        await Promise.resolve();
      });
      expect(syncState).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      unmount();
      expect(vi.getTimerCount()).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(syncState).toHaveBeenCalledTimes(1);
      expect(getAccount).toHaveBeenCalledTimes(1);
    });

    it("stops immediately when unmounted while syncState is in flight", async () => {
      let resolveSync!: () => void;
      const syncState = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSync = resolve;
          })
      );
      const getAccount = vi.fn();
      const mockClient = createMockWebClient({ syncState, getAccount });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result, unmount } = renderHook(() => useWaitForAccountUpdate());

      act(() => {
        void result.current.waitForAccountUpdate("0xacc", {
          timeoutMs: 5000,
          intervalMs: 50,
        });
      });

      await waitFor(() => expect(syncState).toHaveBeenCalledTimes(1));

      unmount();
      await act(async () => {
        resolveSync();
        await Promise.resolve();
      });

      expect(getAccount).not.toHaveBeenCalled();
      expect(syncState).toHaveBeenCalledTimes(1);
    });

    it("rejects the active promise, stops polling, and clears timers when unsubscribe() is called", async () => {
      vi.useFakeTimers();
      const unchanged = createAccountWithCommitment("0xbase");
      const syncState = vi.fn().mockResolvedValue({});
      const mockClient = createMockWebClient({
        syncState,
        getAccount: vi.fn().mockResolvedValue(unchanged),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      // Calling unsubscribe when idle is a no-op
      act(() => {
        result.current.unsubscribe();
      });

      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current.waitForAccountUpdate("0xacc", {
          baselineCommitment: "0xbase",
          timeoutMs: 10_000,
          intervalMs: 100,
        });
      });

      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.isWaiting).toBe(true);
      expect(vi.getTimerCount()).toBe(1);

      const assertion = expect(pending).rejects.toThrow(
        "Unsubscribed from account update"
      );
      act(() => {
        result.current.unsubscribe();
      });
      await assertion;

      expect(vi.getTimerCount()).toBe(0);
      expect(result.current.isWaiting).toBe(false);
      expect(result.current.error).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(syncState).toHaveBeenCalledTimes(1);
    });

    it("reset() cancels an active wait and clears account and error state", async () => {
      vi.useFakeTimers();
      const unchanged = createAccountWithCommitment("0xsame");
      const updated = createAccountWithCommitment("0xnew");
      const syncState = vi.fn().mockResolvedValue({});
      const mockClient = createMockWebClient({
        syncState,
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(updated)
          .mockResolvedValue(unchanged),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      await act(async () => {
        await result.current.waitForAccountUpdate("0xacc", {
          baselineCommitment: "0xold",
        });
      });
      expect(result.current.account).toBe(updated);

      // Start a second wait, then reset() while it is sleeping
      act(() => {
        void result.current.waitForAccountUpdate("0xacc", {
          baselineCommitment: "0xsame",
          timeoutMs: 5000,
          intervalMs: 100,
        });
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.isWaiting).toBe(true);
      expect(vi.getTimerCount()).toBe(1);

      act(() => {
        result.current.reset();
      });

      expect(vi.getTimerCount()).toBe(0);
      expect(result.current.account).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isWaiting).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(syncState).toHaveBeenCalledTimes(2);
    });

    it("supports reactive enabled mode and stops when disabled or unmounted", async () => {
      vi.useFakeTimers();
      const acc1 = createAccountWithCommitment("0xv1");
      const acc2 = createAccountWithCommitment("0xv2");
      const syncState = vi.fn().mockResolvedValue({});
      const mockClient = createMockWebClient({
        syncState,
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(acc1)
          .mockResolvedValueOnce(acc2),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result, rerender, unmount } = renderHook(
        ({ enabled }) =>
          useWaitForAccountUpdate("0xacc", {
            enabled,
            timeoutMs: 1000,
            intervalMs: 50,
          }),
        { initialProps: { enabled: true } }
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });

      expect(result.current.account).toBe(acc2);
      expect(result.current.isWaiting).toBe(false);
      expect(syncState).toHaveBeenCalledTimes(2);

      // Re-rendering with same props must not restart the wait
      rerender({ enabled: true });
      expect(syncState).toHaveBeenCalledTimes(2);

      // Disabling and unmounting cleanly leaves zero timers
      rerender({ enabled: false });
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("concurrency, client swap, and error propagation", () => {
    it("supersedes an earlier active wait when waitForAccountUpdate is called again", async () => {
      vi.useFakeTimers();
      const unchanged = createAccountWithCommitment("0xbase");
      const updated = createAccountWithCommitment("0xnew");
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(unchanged)
          .mockResolvedValueOnce(updated),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      let first!: Promise<unknown>;
      act(() => {
        first = result.current.waitForAccountUpdate("0xacc", {
          baselineCommitment: "0xbase",
          timeoutMs: 5000,
          intervalMs: 100,
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      const firstRejection = expect(first).rejects.toThrow(
        "Account update wait was superseded"
      );

      let second!: Promise<unknown>;
      await act(async () => {
        second = result.current.waitForAccountUpdate("0xacc", {
          baselineCommitment: "0xbase",
          timeoutMs: 5000,
          intervalMs: 100,
        });
        await Promise.resolve();
      });

      await firstRejection;
      await expect(second).resolves.toBe(updated);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects with STALE_CLIENT when the client changes or cache resets mid-wait", async () => {
      let releaseSync!: () => void;
      const syncPromise = new Promise<void>((resolve) => {
        releaseSync = resolve;
      });
      const clientA = createMockWebClient({
        syncState: vi.fn().mockReturnValue(syncPromise),
      });
      const clientB = createMockWebClient();
      useMidenStore.getState().setClient(clientA as never);
      mockUseMiden.mockReturnValue({ client: clientA, isReady: true });

      const { result, rerender } = renderHook(() => useWaitForAccountUpdate());

      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current.waitForAccountUpdate("0xacc", {
          timeoutMs: 5000,
        });
      });

      const staleAssertion = expect(pending).rejects.toMatchObject({
        code: "STALE_CLIENT",
      });

      act(() => {
        useMidenStore.getState().setClient(clientB as never);
        mockUseMiden.mockReturnValue({ client: clientB, isReady: true });
        rerender();
      });

      await act(async () => {
        releaseSync();
        await staleAssertion;
      });

      expect(result.current.error).toBeNull();
      expect(result.current.isWaiting).toBe(false);

      // Same client reference, but cacheGeneration advances via resetInMemoryState()
      let releaseSync2!: () => void;
      clientB.syncState = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseSync2 = resolve;
          })
      );
      let pending2!: Promise<unknown>;
      act(() => {
        pending2 = result.current.waitForAccountUpdate("0xacc", {
          timeoutMs: 5000,
        });
      });
      await waitFor(() => expect(clientB.syncState).toHaveBeenCalledTimes(1));

      act(() => {
        useMidenStore.getState().resetInMemoryState();
      });
      const staleAssertion2 = expect(pending2).rejects.toMatchObject({
        code: "STALE_CLIENT",
      });
      await act(async () => {
        releaseSync2();
        await staleAssertion2;
      });
      expect(result.current.error).toBeNull();
      expect(result.current.isWaiting).toBe(false);
    });

    it("propagates syncState and getAccount errors and normalizes non-Error rejections", async () => {
      const mockClient = createMockWebClient({
        syncState: vi
          .fn()
          .mockRejectedValueOnce(new Error("RPC unreachable"))
          .mockRejectedValueOnce("string failure"),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      await act(async () => {
        await expect(
          result.current.waitForAccountUpdate("0xacc")
        ).rejects.toThrow("RPC unreachable");
      });
      expect(result.current.error?.message).toBe("RPC unreachable");
      expect(result.current.isWaiting).toBe(false);

      await act(async () => {
        await expect(
          result.current.waitForAccountUpdate("0xacc")
        ).rejects.toThrow("string failure");
      });
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("string failure");
    });
  });
});
