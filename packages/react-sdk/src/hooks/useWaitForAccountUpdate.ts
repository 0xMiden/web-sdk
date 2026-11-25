import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Word } from "@miden-sdk/miden-sdk";
import type { Account, Word as WordType } from "@miden-sdk/miden-sdk";
import { useMiden } from "../context/MidenProvider";
import { captureClientReadGuard } from "../store/clientReadGuard";
import { useMidenStore } from "../store/MidenStore";
import type {
  AccountRef,
  UseWaitForAccountUpdateOptions,
  WaitForAccountUpdateOptions,
} from "../types";
import { ensureAccountBech32 } from "../utils/accountBech32";
import { parseAccountId } from "../utils/accountParsing";
import { MidenError } from "../utils/errors";
import { runExclusiveDirect } from "../utils/runExclusive";

type CancelMode = "unsubscribe" | "unmount" | "reset" | "superseded" | "stale";

interface ActiveWait {
  token: number;
  cancel: (mode: CancelMode) => void;
}

export interface UseWaitForAccountUpdateResult {
  /**
   * Wait until the account's commitment or watched storage slot/map entry
   * changes past the baseline, returning the updated `Account`.
   */
  waitForAccountUpdate: {
    (): Promise<Account>;
    (options: WaitForAccountUpdateOptions): Promise<Account>;
    (
      accountId: AccountRef,
      options?: Omit<WaitForAccountUpdateOptions, "accountId">
    ): Promise<Account>;
  };
  /**
   * Cancel the active wait, clear pending timers, and stop polling. Rejects
   * the in-flight `waitForAccountUpdate` promise.
   */
  unsubscribe: () => void;
  /** Most recent updated `Account` resolved by this hook, or `null`. */
  account: Account | null;
  /** Whether a wait is currently active. */
  isWaiting: boolean;
  /** Error from the most recent wait, or `null`. */
  error: Error | null;
  /** Cancel any active wait and reset `account` and `error` state. */
  reset: () => void;
}

/**
 * Wait for an externally driven account-state update (for example, a note
 * consumed by a network operator or another client that the local `WebClient`
 * did not submit).
 *
 * Polls `syncState()` and `getAccount()` inside `runExclusive`, comparing
 * `account.to_commitment()` (or `account.storage()` for a `slot` / `mapKey`)
 * against the provided baseline or the initial polled snapshot. Rejects at
 * `timeoutMs` or on `unsubscribe()`, and stops polling with zero leaked timers
 * on component unmount.
 *
 * @example
 * ```tsx
 * function CounterWatcher({ accountId }: { accountId: string }) {
 *   const { waitForAccountUpdate, unsubscribe, isWaiting, error } =
 *     useWaitForAccountUpdate();
 *
 *   const handleWait = async () => {
 *     const updated = await waitForAccountUpdate(accountId, {
 *       slot: "counter::value",
 *       timeoutMs: 30_000,
 *       intervalMs: 1_000,
 *     });
 *     console.log("Updated commitment:", updated.to_commitment().toHex());
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleWait} disabled={isWaiting}>Watch</button>
 *       {isWaiting && <button onClick={unsubscribe}>Cancel</button>}
 *       {error && <p>{error.message}</p>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useWaitForAccountUpdate(): UseWaitForAccountUpdateResult;
export function useWaitForAccountUpdate(
  accountId: AccountRef | undefined,
  options?: UseWaitForAccountUpdateOptions
): UseWaitForAccountUpdateResult;
export function useWaitForAccountUpdate(
  hookAccountId?: AccountRef,
  hookOptions?: UseWaitForAccountUpdateOptions
): UseWaitForAccountUpdateResult {
  const { client, isReady, runExclusive } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;
  const setAccountDetails = useMidenStore((state) => state.setAccountDetails);

  const [account, setAccount] = useState<Account | null>(null);
  const [isWaiting, setIsWaiting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mountedRef = useRef(true);
  const clientRef = useRef(client);
  const waitTokenRef = useRef(0);
  const activeWaitRef = useRef<ActiveWait | null>(null);

  const hookSlot = hookOptions?.slot;
  const hookTimeoutMs = hookOptions?.timeoutMs;
  const hookIntervalMs = hookOptions?.intervalMs;
  const hookEnabled = hookOptions?.enabled ?? false;
  const hookBaselineCommitment = hookOptions?.baselineCommitment;
  const hookMapKey = hookOptions?.mapKey;
  const hookBaselineValue = hookOptions?.baselineValue;

  const hookAccountKey = useMemo(
    () => normalizeAccountRefKey(hookAccountId),
    [hookAccountId]
  );
  const hookBaselineCommitmentKey = useMemo(
    () => readWordHex(hookBaselineCommitment),
    [hookBaselineCommitment]
  );
  const hookMapKeyStr = useMemo(() => readWordHex(hookMapKey), [hookMapKey]);
  const hookBaselineValueKey = useMemo(
    () => normalizeBaselineValueKey(hookBaselineValue),
    [hookBaselineValue]
  );

  const cancelActiveWait = useCallback((mode: CancelMode) => {
    activeWaitRef.current?.cancel(mode);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelActiveWait("unmount");
    };
  }, [cancelActiveWait]);

  useEffect(() => {
    if (clientRef.current !== client) {
      clientRef.current = client;
      cancelActiveWait("stale");
      setAccount(null);
      setError(null);
      setIsWaiting(false);
    }
  }, [client, cancelActiveWait]);

  const startWait = useCallback(
    async (
      accountIdOrOptions?: AccountRef | WaitForAccountUpdateOptions,
      maybeOptions?: Omit<WaitForAccountUpdateOptions, "accountId">
    ): Promise<Account> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      const resolved = mergeOptions(
        hookAccountId,
        hookSlot,
        hookTimeoutMs,
        hookIntervalMs,
        hookBaselineCommitment,
        hookMapKey,
        hookBaselineValue,
        accountIdOrOptions,
        maybeOptions
      );

      const accountIdStr = normalizeAccountRefKey(resolved.accountId);
      if (!accountIdStr) {
        throw new Error("Account ID is required");
      }
      if (resolved.mapKey !== undefined && !resolved.slot) {
        throw new Error(
          "Storage slot name is required when mapKey is specified"
        );
      }

      const mapKeyWord =
        resolved.mapKey === undefined
          ? undefined
          : typeof resolved.mapKey === "string"
            ? Word.fromHex(resolved.mapKey)
            : resolved.mapKey;

      const numericBaseline =
        Boolean(resolved.slot) && typeof resolved.baselineValue === "bigint";
      const initialBaseline = resolveInitialBaseline(
        resolved.slot,
        resolved.baselineCommitment,
        resolved.baselineValue
      );

      const rawTimeout = resolved.timeoutMs ?? 10_000;
      const timeoutMs = Number.isNaN(rawTimeout)
        ? 10_000
        : Math.max(0, rawTimeout);
      const flooredInterval = Math.max(1, resolved.intervalMs ?? 1_000);
      const intervalMs = Number.isNaN(flooredInterval)
        ? 1_000
        : flooredInterval;

      activeWaitRef.current?.cancel("superseded");

      const token = ++waitTokenRef.current;
      const isCurrentClient = captureClientReadGuard(client);
      const isActive = () =>
        mountedRef.current &&
        waitTokenRef.current === token &&
        isCurrentClient();

      setIsWaiting(true);
      setError(null);

      return new Promise<Account>((resolvePromise, rejectPromise) => {
        let settled = false;
        let cancelledMode: CancelMode | null = null;
        let timerId: ReturnType<typeof setTimeout> | null = null;
        let wakeSleep: (() => void) | null = null;

        const cleanupActive = () => {
          if (timerId !== null) {
            clearTimeout(timerId);
            timerId = null;
          }
          if (activeWaitRef.current?.token === token) {
            activeWaitRef.current = null;
          }
        };

        const finishResolve = (updated: Account) => {
          settled = true;
          cleanupActive();
          resolvePromise(updated);
        };

        const finishReject = (err: Error) => {
          if (settled) return;
          settled = true;
          cleanupActive();
          rejectPromise(err);
        };

        const cancel = (mode: CancelMode) => {
          if (cancelledMode !== null) return;
          cancelledMode = mode;
          wakeSleep?.();
          wakeSleep = null;

          if (mode === "unmount" || mode === "reset") {
            // Stop timers and polling without rejecting an unawaited promise
            // during component teardown or explicit state reset.
            settled = true;
            cleanupActive();
            if (mode === "reset" && mountedRef.current) {
              setIsWaiting(false);
            }
            return;
          }

          if (mountedRef.current && waitTokenRef.current === token) {
            setIsWaiting(false);
          }

          if (mode === "stale") {
            finishReject(
              new MidenError(
                "The client changed while waiting for an account update.",
                { code: "STALE_CLIENT" }
              )
            );
            return;
          }

          const message =
            mode === "unsubscribe"
              ? "Unsubscribed from account update"
              : "Account update wait was superseded";
          finishReject(new Error(message));
        };

        activeWaitRef.current = { token, cancel };

        const shouldStop = () => {
          if (cancelledMode !== null) return true;
          if (!isCurrentClient()) {
            cancel("stale");
            return true;
          }
          return false;
        };

        const sleep = (ms: number) =>
          new Promise<void>((resolveSleep) => {
            wakeSleep = resolveSleep;
            timerId = setTimeout(() => {
              timerId = null;
              wakeSleep = null;
              resolveSleep();
            }, ms);
          });

        const poll = async () => {
          const deadline = Date.now() + timeoutMs;
          let baseline = initialBaseline;

          try {
            while (Date.now() < deadline) {
              if (shouldStop()) return;

              await runExclusiveSafe(() => client.syncState());
              if (shouldStop()) return;

              const fetched = await runExclusiveSafe(() => {
                const accountIdObj = parseAccountId(accountIdStr);
                return client.getAccount(accountIdObj);
              });
              if (shouldStop()) return;

              if (fetched) {
                const snapshot = readAccountSnapshot(
                  fetched,
                  resolved.slot,
                  mapKeyWord,
                  numericBaseline
                );
                if (baseline === undefined) {
                  baseline = snapshot;
                } else if (snapshot !== baseline) {
                  ensureAccountBech32(fetched);
                  setAccountDetails(accountIdStr, fetched);
                  if (isActive()) {
                    setAccount(fetched);
                    setIsWaiting(false);
                  }
                  finishResolve(fetched);
                  return;
                }
              }

              const remaining = deadline - Date.now();
              if (remaining <= 0) break;

              await sleep(Math.min(intervalMs, remaining));
            }

            if (shouldStop()) return;

            const timeoutError = new Error(
              "Timeout waiting for account update"
            );
            if (isActive()) {
              setError(timeoutError);
              setIsWaiting(false);
            }
            finishReject(timeoutError);
          } catch (err) {
            if (shouldStop()) return;

            const resolvedError =
              err instanceof Error ? err : new Error(String(err));
            if (isActive()) {
              setError(resolvedError);
              setIsWaiting(false);
            }
            finishReject(resolvedError);
          }
        };

        void poll();
      });
    },
    [
      client,
      isReady,
      runExclusiveSafe,
      setAccountDetails,
      hookAccountId,
      hookSlot,
      hookTimeoutMs,
      hookIntervalMs,
      hookBaselineCommitment,
      hookMapKey,
      hookBaselineValue,
    ]
  );

  const unsubscribe = useCallback(() => {
    cancelActiveWait("unsubscribe");
  }, [cancelActiveWait]);

  const reset = useCallback(() => {
    cancelActiveWait("reset");
    setAccount(null);
    setError(null);
    setIsWaiting(false);
  }, [cancelActiveWait]);

  useEffect(() => {
    if (!hookEnabled || !isReady || !client || !hookAccountKey) {
      return;
    }

    // Reactive subscriptions mirror query hooks: errors live in `error` state.
    void startWait().catch(() => {});

    return () => {
      cancelActiveWait("unmount");
    };
  }, [
    hookEnabled,
    isReady,
    client,
    hookAccountKey,
    hookSlot,
    hookMapKeyStr,
    hookBaselineCommitmentKey,
    hookBaselineValueKey,
    hookTimeoutMs,
    hookIntervalMs,
    startWait,
    cancelActiveWait,
  ]);

  return {
    waitForAccountUpdate:
      startWait as UseWaitForAccountUpdateResult["waitForAccountUpdate"],
    unsubscribe,
    account,
    isWaiting,
    error,
    reset,
  };
}

function isAccountRef(value: unknown): value is AccountRef {
  if (typeof value === "string") return true;
  const candidate = value as {
    id?: unknown;
    toHex?: unknown;
    isFaucet?: unknown;
  };
  return (
    typeof candidate.id === "function" ||
    typeof candidate.toHex === "function" ||
    typeof candidate.isFaucet === "function"
  );
}

function mergeOptions(
  hookAccountId: AccountRef | undefined,
  hookSlot: string | undefined,
  hookTimeoutMs: number | undefined,
  hookIntervalMs: number | undefined,
  hookBaselineCommitment: string | WordType | undefined,
  hookMapKey: string | WordType | undefined,
  hookBaselineValue: string | WordType | bigint | null | undefined,
  arg1?: AccountRef | WaitForAccountUpdateOptions,
  arg2?: Omit<WaitForAccountUpdateOptions, "accountId">
): WaitForAccountUpdateOptions {
  const base: WaitForAccountUpdateOptions = {
    accountId: hookAccountId,
    slot: hookSlot,
    timeoutMs: hookTimeoutMs,
    intervalMs: hookIntervalMs,
    baselineCommitment: hookBaselineCommitment,
    mapKey: hookMapKey,
    baselineValue: hookBaselineValue,
  };

  if (arg1 === undefined) {
    return base;
  }
  if (isAccountRef(arg1)) {
    return { ...base, ...arg2, accountId: arg1 };
  }
  return { ...base, ...arg1 };
}

function normalizeAccountRefKey(
  accountId: AccountRef | undefined
): string | undefined {
  if (!accountId) return undefined;
  if (typeof accountId === "string") {
    const trimmed = accountId.trim();
    return trimmed ? trimmed : undefined;
  }
  return parseAccountId(accountId).toString();
}

function readWordHex(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim().toLowerCase();
  const wordLike = value as { toHex?: () => string; toString?: () => string };
  if (typeof wordLike.toHex === "function") {
    return wordLike.toHex().trim().toLowerCase();
  }
  const str = wordLike.toString?.();
  return str && str !== "[object Object]" ? str.trim().toLowerCase() : null;
}

function readWordBigInt(value: unknown): bigint | null {
  if (value === undefined || value === null) return null;
  const record = value as {
    toBigInt?: () => bigint;
    toU64s?: () => ArrayLike<bigint>;
  };
  if (typeof record.toBigInt === "function") {
    return record.toBigInt();
  }
  if (typeof record.toU64s === "function") {
    const u64s = record.toU64s();
    if (u64s.length > 0) return BigInt(u64s[0]);
  }
  return null;
}

function normalizeBaselineValueKey(
  value: string | WordType | bigint | null | undefined
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "bigint") return String(value);
  return readWordHex(value);
}

function resolveInitialBaseline(
  slot: string | undefined,
  baselineCommitment: string | WordType | undefined,
  baselineValue: string | WordType | bigint | null | undefined
): string | null | undefined {
  if (slot && baselineValue !== undefined) {
    return normalizeBaselineValueKey(baselineValue);
  }
  if (baselineCommitment !== undefined) {
    return readWordHex(baselineCommitment);
  }
  return undefined;
}

type StorageLike = {
  getCommitment?: (slotName: string) => unknown;
  getItem?: (slotName: string) => unknown;
  getMapItem?: (slotName: string, key: WordType) => unknown;
};

function readAccountSnapshot(
  account: Account,
  slot: string | undefined,
  mapKeyWord: WordType | undefined,
  numericBaseline: boolean
): string | null {
  if (!slot) {
    return readWordHex(account.to_commitment());
  }

  const storage = account.storage() as unknown as StorageLike;

  if (mapKeyWord !== undefined) {
    const entry = storage.getMapItem?.(slot, mapKeyWord);
    if (numericBaseline) {
      const val = readWordBigInt(entry);
      return val === null ? null : String(val);
    }
    return readWordHex(entry);
  }

  if (numericBaseline) {
    const item = storage.getItem?.(slot);
    const val = readWordBigInt(item);
    return val === null ? null : String(val);
  }

  if (typeof storage.getCommitment === "function") {
    return readWordHex(storage.getCommitment(slot));
  }

  const item = storage.getItem?.(slot);
  if (item && typeof item === "object") {
    const maybeMap = item as {
      isMap?: boolean;
      entries?: Array<{ key: string; value: string }>;
    };
    if (maybeMap.isMap && Array.isArray(maybeMap.entries)) {
      return maybeMap.entries
        .map(
          (entry) => `${entry.key.toLowerCase()}:${entry.value.toLowerCase()}`
        )
        .sort()
        .join("|");
    }
  }
  return readWordHex(item);
}
