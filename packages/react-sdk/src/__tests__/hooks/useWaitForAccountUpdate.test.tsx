import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { AccountId, Address, Word } from "@miden-sdk/miden-sdk";
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

    it("accepts real-shape WASM AccountId without toHex or isFaucet as first argument with options", async () => {
      const updated = createAccountWithCommitment("0xreal_new");
      const getAccount = vi.fn().mockResolvedValue(updated);
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount,
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      // Real WASM AccountId exposes isPublic/isPrivate/toString/toBech32/prefix/suffix,
      // and has no id(), toHex(), or isFaucet() methods.
      const realShapeAccountId = {
        isPublic: vi.fn(() => true),
        isPrivate: vi.fn(() => false),
        toString: vi.fn(() => "0xreal_wasm_id"),
        toBech32: vi.fn(() => "mtst1real"),
        prefix: vi.fn(() => ({})),
        suffix: vi.fn(() => ({})),
        free: vi.fn(),
      };

      const { result } = renderHook(() => useWaitForAccountUpdate());
      let resolved: unknown;
      await act(async () => {
        resolved = await result.current.waitForAccountUpdate(
          realShapeAccountId as never,
          {
            baselineCommitment: "0xold",
            timeoutMs: 200,
            intervalMs: 1,
          }
        );
      });
      expect(resolved).toBe(updated);
      expect(realShapeAccountId.free).not.toHaveBeenCalled();

      // When hook default accountId exists, real-shape AccountId must still override it
      const { result: configured } = renderHook(() =>
        useWaitForAccountUpdate("0xhook_default")
      );
      getAccount.mockClear();
      await act(async () => {
        await configured.current.waitForAccountUpdate(
          realShapeAccountId as never,
          {
            baselineCommitment: "0xold",
            timeoutMs: 200,
            intervalMs: 1,
          }
        );
      });
      expect(getAccount.mock.calls[0]?.[0]?.toString()).toBe("0xreal_wasm_id");
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

    it("uses StorageView.getCommitment for map slots and falls back to raw AccountStorage.getItem", async () => {
      vi.useFakeTimers();
      const getItem1 = vi.fn(() => createWord("0xunused1"));
      const getItem2 = vi.fn(() => createWord("0xunused2"));
      const acc1 = createAccountWithCommitment("0xcomm1", {
        getCommitment: vi.fn(() => createWord("0xmaproot1")),
        getItem: getItem1,
      });
      const acc2 = createAccountWithCommitment("0xcomm2", {
        getCommitment: vi.fn(() => createWord("0xmaproot2")),
        getItem: getItem2,
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
      expect(getItem1).not.toHaveBeenCalled();
      expect(getItem2).not.toHaveBeenCalled();

      // Raw AccountStorage fallback (no getCommitment): compares Word from getItem()
      const raw1 = createAccountWithCommitment("0xcomm3", {
        getItem: vi.fn(() => createWord("0xraw_slot_v1")),
      });
      const raw2 = createAccountWithCommitment("0xcomm4", {
        getItem: vi.fn(() => createWord("0xraw_slot_v2")),
      });
      mockClient.getAccount = vi
        .fn()
        .mockResolvedValueOnce(raw1)
        .mockResolvedValueOnce(raw2);

      let rawPending!: Promise<unknown>;
      act(() => {
        rawPending = result.current.waitForAccountUpdate({
          accountId: "0xacc",
          slot: "raw::counter",
          timeoutMs: 500,
          intervalMs: 25,
        });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30);
      });

      await expect(rawPending).resolves.toBe(raw2);
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
      let pending!: Promise<unknown>;
      let pendingStatus = "pending";
      act(() => {
        pending = result.current.waitForAccountUpdate("0xacc", {
          baselineCommitment: "0xsame",
          timeoutMs: 5000,
          intervalMs: 100,
        });
        void pending.then(
          () => {
            pendingStatus = "resolved";
          },
          (err: unknown) => {
            pendingStatus = `rejected:${err instanceof Error ? err.message : String(err)}`;
          }
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.isWaiting).toBe(true);
      expect(vi.getTimerCount()).toBe(1);

      act(() => {
        result.current.reset();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(pendingStatus).toBe("rejected:Account update wait was reset");
      await expect(pending).rejects.toThrow("Account update wait was reset");
      expect(vi.getTimerCount()).toBe(0);
      expect(result.current.account).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isWaiting).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(syncState).toHaveBeenCalledTimes(2);

      // Reactive mode reset() clears state cleanly without setting error
      const { result: reactive } = renderHook(() =>
        useWaitForAccountUpdate("0xacc", {
          enabled: true,
          baselineCommitment: "0xsame",
          timeoutMs: 5000,
          intervalMs: 100,
        })
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(reactive.current.isWaiting).toBe(true);
      act(() => {
        reactive.current.reset();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(reactive.current.account).toBeNull();
      expect(reactive.current.error).toBeNull();
      expect(reactive.current.isWaiting).toBe(false);
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

    it("clears isWaiting and stops polling when reactive enabled switches to false while mounted", async () => {
      vi.useFakeTimers();
      const unchanged = createAccountWithCommitment("0xbase");
      const syncState = vi.fn().mockResolvedValue({});
      const mockClient = createMockWebClient({
        syncState,
        getAccount: vi.fn().mockResolvedValue(unchanged),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result, rerender } = renderHook(
        ({ enabled }) =>
          useWaitForAccountUpdate("0xacc", {
            enabled,
            timeoutMs: 10_000,
            intervalMs: 100,
          }),
        { initialProps: { enabled: true } }
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.isWaiting).toBe(true);
      expect(syncState).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      rerender({ enabled: false });
      expect(result.current.isWaiting).toBe(false);
      expect(result.current.error).toBeNull();
      expect(vi.getTimerCount()).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(syncState).toHaveBeenCalledTimes(1);
    });

    it("does not restart reactive wait when recreated AccountRef or Word props represent the same values", async () => {
      vi.useFakeTimers();
      const unchanged = createAccountWithCommitment("0xbase", {
        getMapItem: vi.fn(() => createWord("0xval1")),
      });
      const updated = createAccountWithCommitment("0xupdated", {
        getMapItem: vi.fn(() => createWord("0xval2")),
      });
      const syncState = vi.fn().mockResolvedValue({});
      const getAccount = vi
        .fn()
        .mockResolvedValueOnce(unchanged)
        .mockResolvedValueOnce(updated);
      const mockClient = createMockWebClient({ syncState, getAccount });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result, rerender } = renderHook(
        ({ accRef, baselineWord, mapKeyWord, baselineVal }) =>
          useWaitForAccountUpdate(accRef as never, {
            enabled: true,
            baselineCommitment: baselineWord as unknown as Word,
            mapKey: mapKeyWord as unknown as Word,
            slot: "my::map",
            baselineValue: baselineVal as unknown as Word,
            timeoutMs: 5000,
            intervalMs: 100,
          }),
        {
          initialProps: {
            accRef: createMockAccountId("0xacc"),
            baselineWord: createWord("0xbase"),
            mapKeyWord: createWord("0xkey"),
            baselineVal: createWord("0xval1"),
          },
        }
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(syncState).toHaveBeenCalledTimes(1);
      expect(result.current.isWaiting).toBe(true);

      // New object references with equal serialized keys must not cancel/restart the loop.
      rerender({
        accRef: createMockAccountId("0xacc"),
        baselineWord: createWord("0xbase"),
        mapKeyWord: createWord("0xkey"),
        baselineVal: createWord("0xval1"),
      });
      expect(syncState).toHaveBeenCalledTimes(1);
      expect(result.current.isWaiting).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(syncState).toHaveBeenCalledTimes(2);
      expect(result.current.account).toBe(updated);
      expect(result.current.isWaiting).toBe(false);
    });

    it("rejects on timeout when slow getAccount completes after timeoutMs instead of resolving late", async () => {
      const updated = createAccountWithCommitment("0xnew");
      const getAccount = vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(updated), 60);
          })
      );
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount,
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      await act(async () => {
        await expect(
          result.current.waitForAccountUpdate("0xacc", {
            baselineCommitment: "0xold",
            timeoutMs: 30,
          })
        ).rejects.toThrow("Timeout waiting for account update");
      });
      expect(result.current.account).toBeNull();
      expect(result.current.error?.message).toBe(
        "Timeout waiting for account update"
      );
      expect(result.current.isWaiting).toBe(false);
    }, 10000);

    it("handles null passed as accountId without throwing TypeError", async () => {
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      await act(async () => {
        await expect(
          result.current.waitForAccountUpdate(null as never)
        ).rejects.toThrow("Account ID is required");
      });
      expect(result.current.error?.message).toBe("Account ID is required");
    });

    it("sets error state when reactive options fail pre-poll validation", async () => {
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() =>
        useWaitForAccountUpdate("0xacc", {
          enabled: true,
          mapKey: "0xkey",
        })
      );

      await waitFor(() => {
        expect(result.current.error?.message).toBe(
          "Storage slot name is required when mapKey is specified"
        );
      });
      expect(result.current.isWaiting).toBe(false);
      expect(mockClient.syncState).not.toHaveBeenCalled();
    });

    it("frees internally constructed Word for hex mapKey while leaving caller Word untouched", async () => {
      const updated = createAccountWithCommitment("0xnew", {
        getMapItem: vi.fn(() => createWord("0xval_new")),
      });
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi.fn().mockResolvedValue(updated),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const fromHexSpy = vi.spyOn(Word, "fromHex");
      const { result } = renderHook(() => useWaitForAccountUpdate());

      await act(async () => {
        await result.current.waitForAccountUpdate("0xacc", {
          slot: "my::map",
          mapKey: "0xdeadbeef",
          baselineValue: "0xval_old",
          timeoutMs: 500,
        });
      });

      expect(fromHexSpy).toHaveBeenCalledWith("0xdeadbeef");
      const internalWord = fromHexSpy.mock.results[0]?.value as {
        free: ReturnType<typeof vi.fn>;
      };
      expect(internalWord.free).toHaveBeenCalledTimes(1);

      // Caller-provided Word instance must not be freed by the hook.
      const callerWord = createWord("0xcaller");
      await act(async () => {
        await result.current.waitForAccountUpdate("0xacc", {
          slot: "my::map",
          mapKey: callerWord as unknown as Word,
          baselineValue: "0xval_old",
          timeoutMs: 500,
        });
      });
      expect(callerWord.free).not.toHaveBeenCalled();
    });

    it("keeps an imperative wait alive when a superseded reactive subscription cleans up", async () => {
      vi.useFakeTimers();
      const unchanged = createAccountWithCommitment("0xbase");
      const updated = createAccountWithCommitment("0xnew");
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(unchanged)
          .mockResolvedValueOnce(unchanged)
          .mockResolvedValueOnce(updated),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result, rerender } = renderHook(
        ({ enabled }) =>
          useWaitForAccountUpdate("0xacc", {
            enabled,
            timeoutMs: 5000,
            intervalMs: 100,
          }),
        { initialProps: { enabled: true } }
      );

      await act(async () => {
        await Promise.resolve();
      });

      let imperativePromise!: Promise<unknown>;
      await act(async () => {
        imperativePromise = result.current.waitForAccountUpdate("0xacc", {
          baselineCommitment: "0xbase",
          timeoutMs: 5000,
          intervalMs: 100,
        });
        await Promise.resolve();
      });

      // Disabling reactive mode cleans up only the superseded reactive token.
      rerender({ enabled: false });
      expect(result.current.isWaiting).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      await expect(imperativePromise).resolves.toBe(updated);
      expect(result.current.isWaiting).toBe(false);
    });

    it("compares full four-limb Words before scalar toBigInt when baselineValue is bigint", async () => {
      vi.useFakeTimers();
      const wordSame = new Word([1n, 0n, 0n, 0n]);
      const wordUpperChanged = new Word([1n, 2n, 0n, 0n]);
      const mapAcc1 = createAccountWithCommitment("0x1", {
        getMapItem: vi.fn(() => wordSame),
      });
      const mapAcc2 = createAccountWithCommitment("0x2", {
        getMapItem: vi.fn(() => wordUpperChanged),
      });

      const slotSame = {
        toBigInt: vi.fn(() => 1n),
        toU64s: vi.fn(() => [1n, 0n, 0n, 0n]),
        free: vi.fn(),
      };
      const slotUpperChanged = {
        toBigInt: vi.fn(() => 1n),
        toU64s: vi.fn(() => [1n, 2n, 0n, 0n]),
        free: vi.fn(),
      };
      const slotAcc1 = createAccountWithCommitment("0x3", {
        getItem: vi.fn(() => slotSame),
      });
      const slotAcc2 = createAccountWithCommitment("0x4", {
        getItem: vi.fn(() => slotUpperChanged),
      });

      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(mapAcc1)
          .mockResolvedValueOnce(mapAcc2)
          .mockResolvedValueOnce(slotAcc1)
          .mockResolvedValueOnce(slotAcc2),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      let mapPending!: Promise<unknown>;
      act(() => {
        mapPending = result.current.waitForAccountUpdate("0xacc", {
          slot: "counter::map",
          mapKey: "0x01",
          baselineValue: 1n,
          timeoutMs: 1000,
          intervalMs: 50,
        });
      });

      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      await expect(mapPending).resolves.toBe(mapAcc2);

      let slotPending!: Promise<unknown>;
      act(() => {
        slotPending = result.current.waitForAccountUpdate("0xacc", {
          slot: "counter::value",
          baselineValue: 1n,
          timeoutMs: 1000,
          intervalMs: 50,
        });
      });

      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      await expect(slotPending).resolves.toBe(slotAcc2);
    });

    it("isolates mode and target baselines in mergeOptions without leaking hook defaults", async () => {
      vi.useFakeTimers();
      const slotPoll1 = createAccountWithCommitment("0xcommit_new", {
        getCommitment: vi.fn(() => createWord("0xslot_v1")),
      });
      const slotPoll2 = createAccountWithCommitment("0xcommit_new", {
        getCommitment: vi.fn(() => createWord("0xslot_v2")),
      });
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(slotPoll1)
          .mockResolvedValueOnce(slotPoll2),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      // Account-level baselineCommitment must not leak into imperative { slot } wait.
      const { result: commitHook } = renderHook(() =>
        useWaitForAccountUpdate("0xacc", {
          baselineCommitment: "0xcommit_old",
          timeoutMs: 500,
          intervalMs: 50,
        })
      );

      let slotPending!: Promise<unknown>;
      act(() => {
        slotPending = commitHook.current.waitForAccountUpdate({
          slot: "counter::value",
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      await expect(slotPending).resolves.toBe(slotPoll2);

      // Slot/mapKey/baselineValue must not leak across baselineCommitment, slot, or mapKey overrides.
      const c1 = createAccountWithCommitment("0xcommit_old", {
        getMapItem: vi.fn(() => createWord("0xslot_different")),
      });
      const c2 = createAccountWithCommitment("0xcommit_changed");
      const s1 = createAccountWithCommitment("0xcommit_changed", {
        getCommitment: vi.fn(() => createWord("0xs2_v1")),
        getMapItem: vi.fn(() => createWord("0xk2_v1")),
      });
      const s2 = createAccountWithCommitment("0xcommit_changed", {
        getCommitment: vi.fn(() => createWord("0xs2_v2")),
        getMapItem: vi.fn(() => createWord("0xk2_v2")),
      });
      mockClient.getAccount = vi
        .fn()
        .mockResolvedValueOnce(c1)
        .mockResolvedValueOnce(c2)
        .mockResolvedValueOnce(s1)
        .mockResolvedValueOnce(s2)
        .mockResolvedValueOnce(s1)
        .mockResolvedValueOnce(s2);

      const { result: slotHook } = renderHook(() =>
        useWaitForAccountUpdate("0xacc", {
          slot: "s1",
          mapKey: "0x01",
          baselineValue: "0xslot_different",
          timeoutMs: 500,
          intervalMs: 50,
        })
      );

      let commitPending!: Promise<unknown>;
      act(() => {
        commitPending = slotHook.current.waitForAccountUpdate({
          baselineCommitment: "0xcommit_old",
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      await expect(commitPending).resolves.toBe(c2);

      let diffSlotPending!: Promise<unknown>;
      act(() => {
        diffSlotPending = slotHook.current.waitForAccountUpdate("0xacc2", {
          slot: "s2",
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      await expect(diffSlotPending).resolves.toBe(s2);

      let diffKeyPending!: Promise<unknown>;
      act(() => {
        diffKeyPending = slotHook.current.waitForAccountUpdate({
          mapKey: "0x02",
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      await expect(diffKeyPending).resolves.toBe(s2);
    });

    it("handles throwing AccountRef safely during disabled render, imperative rejection, and enabled error state", async () => {
      const mockClient = createMockWebClient();
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const badRef = {
        id: vi.fn(() => {
          throw new Error("corrupt handle");
        }),
      };

      const { result: disabledHook } = renderHook(() =>
        useWaitForAccountUpdate(badRef as never, { enabled: false })
      );
      expect(disabledHook.current.error).toBeNull();
      expect(disabledHook.current.isWaiting).toBe(false);

      await act(async () => {
        await expect(
          disabledHook.current.waitForAccountUpdate()
        ).rejects.toThrow("corrupt handle");
      });
      expect(disabledHook.current.error?.message).toBe("corrupt handle");

      const { result: enabledHook } = renderHook(() =>
        useWaitForAccountUpdate(badRef as never, { enabled: true })
      );
      await waitFor(() => {
        expect(enabledHook.current.error?.message).toBe("corrupt handle");
      });
      expect(enabledHook.current.isWaiting).toBe(false);
    });

    it("skips getAccount when syncState crosses the deadline and validates Word.fromHex / Word.deserialize", async () => {
      vi.useFakeTimers();
      const runExclusive = vi.fn(<T,>(fn: () => Promise<T>) => fn());
      const mockClient = createMockWebClient({
        syncState: vi.fn(async () => {
          await vi.advanceTimersByTimeAsync(60);
          return {};
        }),
      });
      mockUseMiden.mockReturnValue({
        client: mockClient,
        isReady: true,
        runExclusive,
      });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());

      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current.waitForAccountUpdate("0xacc", {
          baselineCommitment: "0xbase",
          timeoutMs: 50,
          intervalMs: 100,
        });
      });

      await act(async () => {
        await expect(pending).rejects.toThrow(
          "Timeout waiting for account update"
        );
      });
      expect(runExclusive).toHaveBeenCalledTimes(1);
      expect(mockClient.getAccount).not.toHaveBeenCalled();

      // Invalid hex mapKey is rejected by Word.fromHex and populates error state
      await act(async () => {
        await expect(
          result.current.waitForAccountUpdate("0xacc", {
            slot: "s",
            mapKey: "not-hex",
          })
        ).rejects.toThrow("Invalid hex string for Word");
      });
      expect(result.current.error?.message).toBe("Invalid hex string for Word");

      const parsed = Word.fromHex(
        "0x0000000000000001000000000000000200000000000000000000000000000000"
      );
      expect(parsed).toBeInstanceOf(Word);
      expect(parsed.toU64s()).toEqual([1n, 2n, 0n, 0n]);
      expect(parsed.toHex()).toBe(
        "0x0000000000000001000000000000000200000000000000000000000000000000"
      );
      expect(() => parsed.free()).not.toThrow();

      const deserialized = Word.deserialize(new Uint8Array());
      expect(deserialized).toBeInstanceOf(Word);
      expect(deserialized.toU64s()).toEqual([0n, 0n, 0n, 0n]);
      expect(deserialized.toHex()).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      );
    });

    it("preserves active wait error nullability across secondary invalid calls and frees transient WASM handles", async () => {
      vi.useFakeTimers();
      const poll1Word = createWord("0xold");
      const poll2Word = createWord("0xnew");
      const poll1Raw = { free: vi.fn() };
      const poll2Raw = { free: vi.fn() };
      const acc1 = createAccountWithCommitment("0x1", {
        getCommitment: vi.fn(() => poll1Word),
        raw: poll1Raw,
      });
      const acc2 = createAccountWithCommitment("0x2", {
        getCommitment: vi.fn(() => poll2Word),
        raw: poll2Raw,
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

      const accountHeader = createMockAccountHeader("0xheader_free");
      const { result } = renderHook(() => useWaitForAccountUpdate());

      let activePending!: Promise<unknown>;
      act(() => {
        activePending = result.current.waitForAccountUpdate(
          accountHeader as never,
          {
            slot: "s",
            timeoutMs: 1000,
            intervalMs: 50,
          }
        );
      });

      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.isWaiting).toBe(true);

      // Invalid second call must reject without clobbering active wait error/isWaiting
      await act(async () => {
        await expect(
          result.current.waitForAccountUpdate("0xacc", { mapKey: "0x01" })
        ).rejects.toThrow(
          "Storage slot name is required when mapKey is specified"
        );
      });
      expect(result.current.error).toBeNull();
      expect(result.current.isWaiting).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      await expect(activePending).resolves.toBe(acc2);
      expect(result.current.error).toBeNull();
      expect(result.current.isWaiting).toBe(false);

      expect(acc1.free).toHaveBeenCalledTimes(1);
      expect(acc2.free).not.toHaveBeenCalled();
      expect(poll1Word.free).toHaveBeenCalledTimes(1);
      expect(poll2Word.free).toHaveBeenCalledTimes(1);
      expect(poll1Raw.free).toHaveBeenCalledTimes(1);
      expect(poll2Raw.free).toHaveBeenCalledTimes(1);
      expect(accountHeader.free).not.toHaveBeenCalled();
    });

    describe("fixes mergeOptions baseline preservation, cross-account isolation, nullish args, and explicit mapKey clearing", () => {
      it("preserves hookBaselineCommitment on matching slot and mapKey overrides", async () => {
        vi.useFakeTimers();
        const settle = (p: Promise<unknown>) =>
          p.then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error })
          );
        const slotChanged = createAccountWithCommitment("0xcommit", {
          getCommitment: vi.fn(() => createWord("0xslot_new")),
        });
        const mapChanged = createAccountWithCommitment("0xcommit", {
          getCommitment: vi.fn(() => createWord("0xmap_new")),
          getMapItem: vi.fn(() => createWord("0xmap_new")),
        });
        const slotClient = createMockWebClient({
          syncState: vi.fn().mockResolvedValue({}),
          getAccount: vi.fn().mockResolvedValue(slotChanged),
        });
        mockUseMiden.mockReturnValue({ client: slotClient, isReady: true });
        useMidenStore.getState().setClient(slotClient as never);

        const { result: slotHook } = renderHook(() =>
          useWaitForAccountUpdate("0xacc", {
            slot: "s1",
            baselineCommitment: "0xold",
            timeoutMs: 200,
            intervalMs: 50,
          })
        );

        let slotOutcome!: Promise<
          { ok: true; value: unknown } | { ok: false; error: unknown }
        >;
        act(() => {
          slotOutcome = settle(
            slotHook.current.waitForAccountUpdate({
              slot: "s1",
              timeoutMs: 200,
              intervalMs: 50,
            })
          );
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });
        expect(await slotOutcome).toEqual({ ok: true, value: slotChanged });

        const mapClient = createMockWebClient({
          syncState: vi.fn().mockResolvedValue({}),
          getAccount: vi.fn().mockResolvedValue(mapChanged),
        });
        mockUseMiden.mockReturnValue({ client: mapClient, isReady: true });
        useMidenStore.getState().setClient(mapClient as never);

        const { result: mapHook } = renderHook(() =>
          useWaitForAccountUpdate("0xacc", {
            slot: "s1",
            mapKey: "0x01",
            baselineCommitment: "0xold",
            timeoutMs: 200,
            intervalMs: 50,
          })
        );

        let mapOutcome!: Promise<
          { ok: true; value: unknown } | { ok: false; error: unknown }
        >;
        act(() => {
          mapOutcome = settle(
            mapHook.current.waitForAccountUpdate({
              mapKey: "0x01",
              timeoutMs: 200,
              intervalMs: 50,
            })
          );
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });
        expect(await mapOutcome).toEqual({ ok: true, value: mapChanged });
      });

      it("clears inherited hook baselines when switching accountId and preserves for normalized equal accountId", async () => {
        vi.useFakeTimers();
        const settle = (p: Promise<unknown>) =>
          p.then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error })
          );
        const acc2v1 = createAccountWithCommitment("0xacc2_v1");
        const acc2v2 = createAccountWithCommitment("0xacc2_v2");
        const acc1Changed = createAccountWithCommitment("0xacc1_new");
        const mockClient = createMockWebClient({
          syncState: vi.fn().mockResolvedValue({}),
          getAccount: vi
            .fn()
            .mockResolvedValueOnce(acc2v1)
            .mockResolvedValueOnce(acc2v2)
            .mockResolvedValueOnce(acc1Changed)
            .mockResolvedValueOnce(acc2v2),
        });
        mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
        useMidenStore.getState().setClient(mockClient as never);

        const { result } = renderHook(() =>
          useWaitForAccountUpdate("0xacc1", {
            baselineCommitment: "0xacc1_old",
            timeoutMs: 200,
            intervalMs: 50,
          })
        );

        let diffOutcome!: Promise<
          { ok: true; value: unknown } | { ok: false; error: unknown }
        >;
        act(() => {
          diffOutcome = settle(
            result.current.waitForAccountUpdate("0xacc2", {
              timeoutMs: 200,
              intervalMs: 50,
            })
          );
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });
        expect(await diffOutcome).toEqual({ ok: true, value: acc2v2 });

        // Whitespace-padded equal accountId still inherits hook baselineCommitment
        let sameOutcome!: Promise<
          { ok: true; value: unknown } | { ok: false; error: unknown }
        >;
        act(() => {
          sameOutcome = settle(result.current.waitForAccountUpdate(" 0xacc1 "));
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });
        expect(await sameOutcome).toEqual({ ok: true, value: acc1Changed });

        // Corrupt hook default AccountRef does not block overriding with valid accountId
        const corruptRef = {
          id: vi.fn(() => {
            throw new Error("corrupt hook default");
          }),
        };
        const { result: corruptHook } = renderHook(() =>
          useWaitForAccountUpdate(corruptRef as never, {
            baselineCommitment: "0xold",
            timeoutMs: 200,
            intervalMs: 50,
          })
        );
        let overrideOutcome!: Promise<
          { ok: true; value: unknown } | { ok: false; error: unknown }
        >;
        act(() => {
          overrideOutcome = settle(
            corruptHook.current.waitForAccountUpdate("0xvalid", {
              baselineCommitment: "0xbase",
            })
          );
        });
        await act(async () => {
          await Promise.resolve();
        });
        expect(await overrideOutcome).toEqual({ ok: true, value: acc2v2 });
      });

      it("preserves arg2 options when arg1 is undefined", async () => {
        vi.useFakeTimers();
        const settle = (p: Promise<unknown>) =>
          p.then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error })
          );
        const changed = createAccountWithCommitment("0xnew");
        const mockClient = createMockWebClient({
          syncState: vi.fn().mockResolvedValue({}),
          getAccount: vi.fn().mockResolvedValueOnce(changed),
        });
        mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
        useMidenStore.getState().setClient(mockClient as never);

        const { result } = renderHook(() =>
          useWaitForAccountUpdate("0xacc", {
            timeoutMs: 200,
            intervalMs: 50,
          })
        );

        let outcome!: Promise<
          { ok: true; value: unknown } | { ok: false; error: unknown }
        >;
        act(() => {
          outcome = settle(
            result.current.waitForAccountUpdate(undefined as never, {
              baselineCommitment: "0xold",
              timeoutMs: 200,
              intervalMs: 50,
            })
          );
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });
        expect(await outcome).toEqual({ ok: true, value: changed });
      });

      it("rejects explicit null accountId instead of falling back to hookAccountId", async () => {
        const mockClient = createMockWebClient();
        mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
        useMidenStore.getState().setClient(mockClient as never);

        const { result } = renderHook(() =>
          useWaitForAccountUpdate("0xacc", {
            timeoutMs: 50,
            intervalMs: 10,
          })
        );

        await act(async () => {
          await expect(
            result.current.waitForAccountUpdate(null as never)
          ).rejects.toThrow("Account ID is required");
        });
        await act(async () => {
          await expect(
            result.current.waitForAccountUpdate({ accountId: null as never })
          ).rejects.toThrow("Account ID is required");
        });
        expect(mockClient.syncState).not.toHaveBeenCalled();
      });

      it("clears hookMapKey and hookBaselineValue when mapKey is explicitly undefined", async () => {
        vi.useFakeTimers();
        const settle = (p: Promise<unknown>) =>
          p.then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error })
          );
        const unchangedMap = createWord("0xmap_old");
        const getMapItem = vi.fn(() => unchangedMap);
        const slotV1 = createAccountWithCommitment("0xcommit", {
          getCommitment: vi.fn(() => createWord("0xslot_v1")),
          getMapItem,
        });
        const slotV2 = createAccountWithCommitment("0xcommit", {
          getCommitment: vi.fn(() => createWord("0xslot_v2")),
          getMapItem,
        });
        const mockClient = createMockWebClient({
          syncState: vi.fn().mockResolvedValue({}),
          getAccount: vi
            .fn()
            .mockResolvedValueOnce(slotV1)
            .mockResolvedValueOnce(slotV2),
        });
        mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
        useMidenStore.getState().setClient(mockClient as never);

        const { result } = renderHook(() =>
          useWaitForAccountUpdate("0xacc", {
            slot: "s1",
            mapKey: "0x01",
            baselineValue: "0xmap_old",
            timeoutMs: 200,
            intervalMs: 50,
          })
        );

        let outcome!: Promise<
          { ok: true; value: unknown } | { ok: false; error: unknown }
        >;
        act(() => {
          outcome = settle(
            result.current.waitForAccountUpdate({
              mapKey: undefined,
              timeoutMs: 200,
              intervalMs: 50,
            })
          );
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });
        expect(await outcome).toEqual({ ok: true, value: slotV2 });
        expect(getMapItem).not.toHaveBeenCalled();
      });
    });

    it("rejects malformed string accountId before calling syncState", async () => {
      vi.useFakeTimers();
      const valid1 = createAccountWithCommitment("0xcommit_v1");
      const valid2 = createAccountWithCommitment("0xcommit_v2");
      const syncState = vi.fn().mockResolvedValue({});
      const mockClient = createMockWebClient({
        syncState,
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(valid1)
          .mockResolvedValueOnce(valid2),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: false });
      useMidenStore.getState().setClient(mockClient as never);

      const prePollAccountId = createMockAccountId("0xvalid");
      const poll1AccountId = createMockAccountId("0xvalid");
      const poll2AccountId = createMockAccountId("0xvalid");
      const fromHexSpy = vi
        .spyOn(AccountId, "fromHex")
        .mockImplementation((hex: string) => {
          if (hex.toLowerCase().includes("not-an-account")) {
            throw new Error("Invalid account ID");
          }
          if (fromHexSpy.mock.calls.length === 1)
            return prePollAccountId as never;
          if (fromHexSpy.mock.calls.length === 2)
            return poll1AccountId as never;
          return poll2AccountId as never;
        });

      try {
        // Under lazy WASM init (isReady=false), render/useMemo must not invoke parseAccountId
        const { result: lazyHook } = renderHook(() =>
          useWaitForAccountUpdate("0xnot-ready-yet", { enabled: true })
        );
        expect(fromHexSpy).not.toHaveBeenCalled();
        await act(async () => {
          await expect(lazyHook.current.waitForAccountUpdate()).rejects.toThrow(
            "Miden client is not ready"
          );
        });
        expect(fromHexSpy).not.toHaveBeenCalled();

        // When ready, invalid string accountId rejects before client.syncState() runs
        mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
        const { result } = renderHook(() => useWaitForAccountUpdate());
        await act(async () => {
          await expect(
            result.current.waitForAccountUpdate("not-an-account", {
              timeoutMs: 500,
            })
          ).rejects.toThrow("Invalid account ID");
        });
        expect(syncState).not.toHaveBeenCalled();
        expect(result.current.error?.message).toBe("Invalid account ID");
        expect(result.current.isWaiting).toBe(false);

        // Valid wait frees pre-poll handle; concurrent invalid string call preserves active wait
        fromHexSpy.mockClear();
        let activePending!: Promise<unknown>;
        act(() => {
          activePending = result.current.waitForAccountUpdate("0xvalid", {
            timeoutMs: 1000,
            intervalMs: 50,
          });
        });
        await act(async () => {
          await Promise.resolve();
        });
        expect(prePollAccountId.free).toHaveBeenCalledTimes(1);
        expect(syncState).toHaveBeenCalledTimes(1);

        await act(async () => {
          await expect(
            result.current.waitForAccountUpdate("not-an-account")
          ).rejects.toThrow("Invalid account ID");
        });
        expect(syncState).toHaveBeenCalledTimes(1);
        expect(result.current.error).toBeNull();
        expect(result.current.isWaiting).toBe(true);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(60);
        });
        await expect(activePending).resolves.toBe(valid2);
      } finally {
        fromHexSpy.mockRestore();
      }
    });

    it("frees fetched Account handle if snapshot inspection or Bech32 conversion throws", async () => {
      const snapshotThrowAcc = createMockAccount({
        // eslint-disable-next-line camelcase
        to_commitment: vi.fn(() => {
          throw new Error("snapshot boom");
        }),
      } as never);
      const storeThrowAcc = createAccountWithCommitment("0xchanged");
      const mockClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi
          .fn()
          .mockResolvedValueOnce(snapshotThrowAcc)
          .mockResolvedValueOnce(storeThrowAcc),
      });
      mockUseMiden.mockReturnValue({ client: mockClient, isReady: true });
      useMidenStore.getState().setClient(mockClient as never);

      const { result } = renderHook(() => useWaitForAccountUpdate());
      await act(async () => {
        await expect(
          result.current.waitForAccountUpdate("0xacc", { timeoutMs: 200 })
        ).rejects.toThrow("snapshot boom");
      });
      expect(snapshotThrowAcc.free).toHaveBeenCalledTimes(1);

      const origSetAccountDetails = useMidenStore.getState().setAccountDetails;
      useMidenStore.setState({
        setAccountDetails: () => {
          throw new Error("store boom");
        },
      });
      try {
        const { result: storeHook } = renderHook(() =>
          useWaitForAccountUpdate()
        );
        await act(async () => {
          await expect(
            storeHook.current.waitForAccountUpdate("0xacc", {
              baselineCommitment: "0xold",
              timeoutMs: 200,
            })
          ).rejects.toThrow("store boom");
        });
        expect(storeThrowAcc.free).toHaveBeenCalledTimes(1);
      } finally {
        useMidenStore.setState({ setAccountDetails: origSetAccountDetails });
      }
    });

    it("clears hook slot on explicit slot: undefined and matches canonical equivalent AccountRefs", async () => {
      vi.useFakeTimers();
      const getItem = vi.fn(() => ({ toBigInt: () => 5n, free: vi.fn() }));
      const acc1 = createAccountWithCommitment("0xacc_v1", {
        getCommitment: vi.fn(() => createWord("0xslot_unchanged")),
        getItem,
      });
      const acc2 = createAccountWithCommitment("0xacc_v2", {
        getCommitment: vi.fn(() => createWord("0xslot_unchanged")),
        getItem,
      });
      const slotClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi.fn().mockResolvedValueOnce(acc1).mockResolvedValue(acc2),
      });
      mockUseMiden.mockReturnValue({ client: slotClient, isReady: true });
      useMidenStore.getState().setClient(slotClient as never);

      // 1. Explicit { slot: undefined } switches back to account-level commitment polling
      const { result: slotHook } = renderHook(() =>
        useWaitForAccountUpdate("0xacc", {
          slot: "s1",
          baselineValue: 5n,
          timeoutMs: 200,
          intervalMs: 50,
        })
      );
      let slotClearOutcome!: Promise<
        { ok: true; value: unknown } | { ok: false; error: unknown }
      >;
      act(() => {
        slotClearOutcome = slotHook.current
          .waitForAccountUpdate({
            slot: undefined,
            timeoutMs: 200,
            intervalMs: 50,
          })
          .then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error })
          );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(await slotClearOutcome).toEqual({ ok: true, value: acc2 });
      expect(getItem).not.toHaveBeenCalled();

      // 2. Canonical equivalent Bech32 / hex / AccountId inputs share sameAccount and free temp handles
      const changed = createAccountWithCommitment("0xchanged");
      const canonicalClient = createMockWebClient({
        syncState: vi.fn().mockResolvedValue({}),
        getAccount: vi.fn().mockResolvedValue(changed),
      });
      mockUseMiden.mockReturnValue({ client: canonicalClient, isReady: true });
      useMidenStore.getState().setClient(canonicalClient as never);

      const freedTempIds: ReturnType<typeof createMockAccountId>[] = [];
      const hexSpy = vi
        .spyOn(AccountId, "fromHex")
        .mockImplementation((hex: string) => {
          const id = createMockAccountId(
            hex.toLowerCase() === "0xhex_same" ? "0x1234" : hex
          );
          freedTempIds.push(id);
          return id as never;
        });
      const bech32Spy = vi
        .spyOn(Address, "fromBech32")
        .mockImplementation((bech32: string) => {
          const id = createMockAccountId(
            bech32 === "mtst1same" ? "0x1234" : bech32
          );
          freedTempIds.push(id);
          return {
            _live: true,
            accountId: vi.fn(() => id),
            toString: vi.fn(() => bech32),
          } as never;
        });

      try {
        const { result: canonicalHook } = renderHook(() =>
          useWaitForAccountUpdate("0xhex_same", {
            baselineCommitment: "0xold",
            timeoutMs: 200,
            intervalMs: 50,
          })
        );
        let bech32Outcome!: Promise<
          { ok: true; value: unknown } | { ok: false; error: unknown }
        >;
        act(() => {
          bech32Outcome = canonicalHook.current
            .waitForAccountUpdate("mtst1same", {
              timeoutMs: 200,
              intervalMs: 50,
            })
            .then(
              (value) => ({ ok: true as const, value }),
              (error) => ({ ok: false as const, error })
            );
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });
        expect(await bech32Outcome).toEqual({ ok: true, value: changed });
        expect(freedTempIds.length).toBeGreaterThan(0);
        for (const tempId of freedTempIds) {
          expect(tempId.free).toHaveBeenCalledTimes(1);
        }

        const callerAccountId = createMockAccountId("0x1234");
        let callerObjOutcome!: Promise<
          { ok: true; value: unknown } | { ok: false; error: unknown }
        >;
        act(() => {
          callerObjOutcome = canonicalHook.current
            .waitForAccountUpdate(callerAccountId as never, {
              timeoutMs: 200,
              intervalMs: 50,
            })
            .then(
              (value) => ({ ok: true as const, value }),
              (error) => ({ ok: false as const, error })
            );
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });
        expect(await callerObjOutcome).toEqual({ ok: true, value: changed });
        expect(callerAccountId.free).not.toHaveBeenCalled();

        // Blank string accountId override clears inherited baseline and avoids WASM parsing
        hexSpy.mockClear();
        await act(async () => {
          await expect(
            canonicalHook.current.waitForAccountUpdate("   ")
          ).rejects.toThrow("Account ID is required");
        });
        expect(hexSpy).not.toHaveBeenCalled();
      } finally {
        hexSpy.mockRestore();
        bech32Spy.mockRestore();
      }
    });
  });
});
