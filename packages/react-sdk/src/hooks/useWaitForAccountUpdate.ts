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

type CancelMode =
  | "unsubscribe"
  | "unmount"
  | "reset"
  | "superseded"
  | "stale"
  | "effect-cleanup";

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
  /**
   * Cancel any active wait, reset `account`, `error`, and `isWaiting` state,
   * and reject an in-flight `waitForAccountUpdate` promise.
   */
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
 * `timeoutMs`, on `unsubscribe()` or `reset()`, when superseded by another
 * wait, or with `STALE_CLIENT` if the client changes, and silently stops
 * polling with zero leaked timers on component unmount.
 *
 * @example
 * ```tsx
 * function CounterWatcher({ accountId }: { accountId: string }) {
 *   const { waitForAccountUpdate, unsubscribe, isWaiting, error } =
 *     useWaitForAccountUpdate();
 *
 *   const handleWait = async () => {
 *     try {
 *       const updated = await waitForAccountUpdate(accountId, {
 *         slot: "counter::value",
 *         timeoutMs: 30_000,
 *         intervalMs: 1_000,
 *       });
 *       console.log("Updated commitment:", updated.to_commitment().toHex());
 *     } catch {
 *       // Failure details are captured in `error`.
 *     }
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

  const hookDefaultsRef = useRef({
    accountId: hookAccountId,
    slot: hookSlot,
    timeoutMs: hookTimeoutMs,
    intervalMs: hookIntervalMs,
    baselineCommitment: hookBaselineCommitment,
    mapKey: hookMapKey,
    baselineValue: hookBaselineValue,
  });
  hookDefaultsRef.current = {
    accountId: hookAccountId,
    slot: hookSlot,
    timeoutMs: hookTimeoutMs,
    intervalMs: hookIntervalMs,
    baselineCommitment: hookBaselineCommitment,
    mapKey: hookMapKey,
    baselineValue: hookBaselineValue,
  };

  const hookAccountKey = useMemo(() => {
    try {
      return normalizeAccountRefKey(hookAccountId);
    } catch (err) {
      return `__invalid__:${err instanceof Error ? err.message : String(err)}`;
    }
  }, [hookAccountId]);
  const hookBaselineCommitmentKey = useMemo(
    () => readWordHex(hookBaselineCommitment),
    [hookBaselineCommitment]
  );
  const hookMapKeyStr = useMemo(() => readWordHex(hookMapKey), [hookMapKey]);
  const hookBaselineValueKey = useMemo(
    () => normalizeBaselineValueKey(hookBaselineValue),
    [hookBaselineValue]
  );

  const cancelActiveWait = useCallback(
    (mode: CancelMode, expectedToken?: number) => {
      if (
        expectedToken !== undefined &&
        activeWaitRef.current?.token !== expectedToken
      ) {
        return;
      }
      activeWaitRef.current?.cancel(mode);
    },
    []
  );

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
      if (!mountedRef.current) {
        return new Promise<Account>(() => {});
      }
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      let resolved: WaitForAccountUpdateOptions;
      let accountIdStr: string | undefined;
      let numericBaseline: boolean;
      let initialBaseline: string | null | undefined;
      let timeoutMs: number;
      let intervalMs: number;
      let mapKeyWord: WordType | undefined;
      let allocatedMapKeyWord: WordType | undefined;

      try {
        const defaults = hookDefaultsRef.current;
        resolved = mergeOptions(defaults, accountIdOrOptions, maybeOptions);

        accountIdStr = normalizeAccountRefKey(resolved.accountId);
        if (!accountIdStr) {
          throw new Error("Account ID is required");
        }
        if (typeof resolved.accountId === "string") {
          let parsedAccountId: ReturnType<typeof parseAccountId> | undefined;
          try {
            parsedAccountId = parseAccountId(accountIdStr);
          } finally {
            safeFree(parsedAccountId);
          }
        }
        if (resolved.mapKey !== undefined && !resolved.slot) {
          throw new Error(
            "Storage slot name is required when mapKey is specified"
          );
        }

        numericBaseline =
          Boolean(resolved.slot) && typeof resolved.baselineValue === "bigint";
        initialBaseline = resolveInitialBaseline(
          resolved.slot,
          resolved.baselineCommitment,
          resolved.baselineValue
        );

        const rawTimeout = resolved.timeoutMs ?? 10_000;
        timeoutMs = Number.isNaN(rawTimeout) ? 10_000 : Math.max(0, rawTimeout);
        const flooredInterval = Math.max(1, resolved.intervalMs ?? 1_000);
        intervalMs = Number.isNaN(flooredInterval) ? 1_000 : flooredInterval;

        if (resolved.mapKey !== undefined) {
          if (typeof resolved.mapKey === "string") {
            mapKeyWord = Word.fromHex(resolved.mapKey);
            allocatedMapKeyWord = mapKeyWord;
          } else {
            mapKeyWord = resolved.mapKey;
          }
        }
      } catch (err) {
        safeFree(allocatedMapKeyWord);
        allocatedMapKeyWord = undefined;
        const resolvedError =
          err instanceof Error ? err : new Error(String(err));
        if (mountedRef.current && !activeWaitRef.current) {
          setError(resolvedError);
          setIsWaiting(false);
        }
        throw resolvedError;
      }

      const requiredAccountIdStr = accountIdStr;

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
          safeFree(allocatedMapKeyWord);
          allocatedMapKeyWord = undefined;
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

          if (mode === "unmount" || mode === "effect-cleanup") {
            // Stop timers and polling without rejecting an unawaited promise
            // during component teardown or reactive cleanup.
            settled = true;
            cleanupActive();
            if (
              mode !== "unmount" &&
              mountedRef.current &&
              waitTokenRef.current === token
            ) {
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
              : mode === "reset"
                ? "Account update wait was reset"
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
              if (Date.now() >= deadline) break;

              const fetched = await runExclusiveSafe(async () => {
                const accountIdObj = parseAccountId(requiredAccountIdStr);
                try {
                  return await client.getAccount(accountIdObj);
                } finally {
                  safeFree(accountIdObj);
                }
              });
              if (shouldStop() || Date.now() >= deadline) {
                safeFree(fetched);
                if (shouldStop()) return;
                break;
              }

              if (fetched) {
                let transferred = false;
                try {
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
                    setAccountDetails(requiredAccountIdStr, fetched);
                    if (isActive()) {
                      setAccount(fetched);
                      setError(null);
                      setIsWaiting(false);
                    }
                    transferred = true;
                    finishResolve(fetched);
                    return;
                  }
                } finally {
                  if (!transferred) {
                    safeFree(fetched);
                  }
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
    [client, isReady, runExclusiveSafe, setAccountDetails]
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

    const beforeToken = waitTokenRef.current;
    // Reactive subscriptions mirror query hooks: errors live in `error` state.
    void startWait().catch(() => {});
    const reactiveToken =
      waitTokenRef.current > beforeToken ? waitTokenRef.current : undefined;

    return () => {
      if (reactiveToken !== undefined) {
        cancelActiveWait("effect-cleanup", reactiveToken);
      }
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

const ACCOUNT_REF_METHODS = [
  "id",
  "toBech32",
  "prefix",
  "suffix",
  "isPublic",
  "isPrivate",
  "toHex",
  "isFaucet",
] as const;

function isAccountRef(value: unknown): value is AccountRef {
  if (typeof value === "string") return true;
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return ACCOUNT_REF_METHODS.some(
    (method) => typeof candidate[method] === "function"
  );
}

function tryCanonicalAccountIdKey(
  accountId: AccountRef | null | undefined
): string | undefined {
  if (!accountId || (typeof accountId === "string" && !accountId.trim())) {
    return undefined;
  }
  try {
    return parseCanonicalAccountIdKey(accountId);
  } catch {
    return undefined;
  }
}

function mergeOptions(
  defaults: WaitForAccountUpdateOptions,
  arg1?: AccountRef | WaitForAccountUpdateOptions,
  arg2?: Omit<WaitForAccountUpdateOptions, "accountId">
): WaitForAccountUpdateOptions {
  const overrides: WaitForAccountUpdateOptions | undefined =
    arg1 === undefined
      ? arg2
      : arg1 === null
        ? { ...arg2, accountId: null as unknown as AccountRef }
        : isAccountRef(arg1)
          ? { ...arg2, accountId: arg1 }
          : arg1;

  const hasExplicitNullAccountId =
    overrides !== undefined &&
    "accountId" in overrides &&
    overrides.accountId === null;
  const accountId = hasExplicitNullAccountId
    ? overrides.accountId
    : (overrides?.accountId ?? defaults.accountId);
  const timeoutMs = overrides?.timeoutMs ?? defaults.timeoutMs;
  const intervalMs = overrides?.intervalMs ?? defaults.intervalMs;
  const hasExplicitSlot = overrides !== undefined && "slot" in overrides;
  const hasExplicitMapKey = overrides !== undefined && "mapKey" in overrides;

  if (
    overrides?.baselineCommitment !== undefined &&
    overrides.slot === undefined &&
    !hasExplicitMapKey
  ) {
    return {
      accountId,
      timeoutMs,
      intervalMs,
      baselineCommitment: overrides.baselineCommitment,
    };
  }

  const slot = hasExplicitSlot ? overrides.slot : defaults.slot;
  const sameSlot = slot === defaults.slot;
  const mapKey = hasExplicitMapKey
    ? overrides.mapKey
    : sameSlot
      ? defaults.mapKey
      : undefined;

  const sameAccount =
    defaults.accountId === undefined ||
    accountId === defaults.accountId ||
    (() => {
      const targetKey = tryCanonicalAccountIdKey(accountId);
      return (
        targetKey !== undefined &&
        targetKey === tryCanonicalAccountIdKey(defaults.accountId)
      );
    })();
  const sameKey =
    sameSlot && readWordHex(mapKey) === readWordHex(defaults.mapKey);
  const sameTarget = sameAccount && sameSlot && sameKey;

  const baselineValue =
    overrides?.baselineValue !== undefined
      ? overrides.baselineValue
      : sameTarget && overrides?.baselineCommitment === undefined
        ? defaults.baselineValue
        : undefined;
  const baselineCommitment =
    overrides?.baselineCommitment !== undefined
      ? overrides.baselineCommitment
      : sameTarget && overrides?.baselineValue === undefined
        ? defaults.baselineCommitment
        : undefined;

  return {
    accountId,
    timeoutMs,
    intervalMs,
    slot,
    mapKey,
    baselineValue,
    baselineCommitment,
  };
}

function safeFree(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const free = (value as { free?: unknown }).free;
  if (typeof free === "function") {
    try {
      (free as () => void).call(value);
    } catch {
      // Ignore WASM double-free or mock cleanup errors.
    }
  }
}

function parseCanonicalAccountIdKey(accountId: AccountRef): string {
  const parsed = parseAccountId(accountId);
  try {
    return parsed.toString();
  } finally {
    if (parsed !== accountId) {
      safeFree(parsed);
    }
  }
}

function normalizeAccountRefKey(
  accountId: AccountRef | undefined
): string | undefined {
  if (!accountId) return undefined;
  if (typeof accountId === "string") {
    const trimmed = accountId.trim();
    return trimmed ? trimmed : undefined;
  }
  return parseCanonicalAccountIdKey(accountId);
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

function readNumericSnapshot(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const record = value as {
    toBigInt?: () => bigint;
    toU64s?: () => ArrayLike<bigint>;
  };
  if (typeof record.toU64s === "function") {
    const u64s = record.toU64s();
    if (u64s.length > 0) {
      let upperNonZero = false;
      for (let i = 1; i < u64s.length; i++) {
        if (BigInt(u64s[i]) !== 0n) {
          upperNonZero = true;
          break;
        }
      }
      if (!upperNonZero) {
        return String(BigInt(u64s[0]));
      }
      return (
        "word:" +
        Array.from({ length: u64s.length }, (_, i) =>
          BigInt(u64s[i]).toString(16).padStart(16, "0")
        ).join("")
      );
    }
  }
  if (typeof record.toBigInt === "function") {
    return String(record.toBigInt());
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
  raw?: unknown;
};

function readAccountSnapshot(
  account: Account,
  slot: string | undefined,
  mapKeyWord: WordType | undefined,
  numericBaseline: boolean
): string | null {
  if (!slot) {
    const commitment = account.to_commitment();
    try {
      return readWordHex(commitment);
    } finally {
      safeFree(commitment);
    }
  }

  const storage = account.storage() as unknown as StorageLike;
  try {
    if (mapKeyWord !== undefined) {
      const entry = storage.getMapItem?.(slot, mapKeyWord);
      try {
        if (numericBaseline) {
          return readNumericSnapshot(entry);
        }
        return readWordHex(entry);
      } finally {
        safeFree(entry);
      }
    }

    if (numericBaseline) {
      const item = storage.getItem?.(slot);
      try {
        return readNumericSnapshot(item);
      } finally {
        if (item && typeof item === "object") {
          safeFree((item as { word?: unknown }).word);
        }
        safeFree(item);
      }
    }

    if (typeof storage.getCommitment === "function") {
      const commitment = storage.getCommitment(slot);
      try {
        return readWordHex(commitment);
      } finally {
        safeFree(commitment);
      }
    }

    const item = storage.getItem?.(slot);
    try {
      return readWordHex(item);
    } finally {
      if (item && typeof item === "object") {
        safeFree((item as { word?: unknown }).word);
      }
      safeFree(item);
    }
  } finally {
    safeFree(storage?.raw);
    safeFree(storage);
  }
}
