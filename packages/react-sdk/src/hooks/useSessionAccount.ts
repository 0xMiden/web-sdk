import { useCallback, useEffect, useRef, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import { useSigner } from "../context/SignerContext";
import { captureClientCurrency, useMidenStore } from "../store/MidenStore";
import { AccountStorageMode, isConsumableNow } from "@miden-sdk/miden-sdk";
import type { ConsumableNoteRecord } from "@miden-sdk/miden-sdk";
import type {
  UseSessionAccountOptions,
  UseSessionAccountReturn,
  SessionAccountStep,
} from "../types";
import { DEFAULTS } from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { ensureAccountBech32 } from "../utils/accountBech32";
import { assertSignerConnected, MidenError } from "../utils/errors";

/**
 * Hook to manage a session wallet lifecycle: create -> fund -> consume.
 *
 * Replaces the common 300+ line pattern of creating a temporary wallet,
 * waiting for funding, and consuming the funding note.
 *
 * @example
 * ```tsx
 * function SessionWallet() {
 *   const { initialize, sessionAccountId, isReady, step, error, reset } =
 *     useSessionAccount({
 *       fund: async (sessionId) => {
 *         // Send tokens from main wallet to session wallet
 *         await send({ from: mainWalletId, to: sessionId, assetId, amount: 100n });
 *       },
 *       assetId: "0x...",
 *     });
 *
 *   if (error) return <div>Error: {error.message} <button onClick={reset}>Retry</button></div>;
 *   if (isReady) return <div>Session ready: {sessionAccountId}</div>;
 *
 *   return (
 *     <button onClick={initialize} disabled={step !== "idle"}>
 *       {step === "idle" ? "Start Session" : step}
 *     </button>
 *   );
 * }
 * ```
 */
export function useSessionAccount(
  options: UseSessionAccountOptions
): UseSessionAccountReturn {
  const {
    client,
    isReady,
    sync,
    clientStoreName = null,
    signerConnected = null,
  } = useMiden();
  const hasSignerProvider = useSigner() !== null;
  const setAccounts = useMidenStore((state) => state.setAccounts);

  const [sessionAccountId, setSessionAccountId] = useState<string | null>(null);
  const [step, setStep] = useState<SessionAccountStep>("idle");
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const [, setResetVersion] = useState(0);
  // A replaced flow must neither block initialization nor clear its successor's guard.
  const isBusyRef = useRef<(() => boolean) | null>(null);

  const storagePrefix = options.storagePrefix ?? "miden-session";
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const maxWaitMs = options.maxWaitMs ?? 60_000;

  // Destructure walletOptions primitives so useCallback deps are stable
  const storageMode = options.walletOptions?.storageMode ?? "public";
  const authScheme = options.walletOptions?.authScheme ?? DEFAULTS.AUTH_SCHEME;

  // Store fund in a ref so the callback identity doesn't change when the
  // caller passes an inline function (the common case).
  const fundRef = useRef(options.fund);
  fundRef.current = options.fund;

  const identityRef = useRef({
    storagePrefix,
    clientStoreName,
    signerConnected,
    hasSignerProvider,
  });
  if (
    identityRef.current.storagePrefix !== storagePrefix ||
    identityRef.current.clientStoreName !== clientStoreName ||
    identityRef.current.signerConnected !== signerConnected ||
    identityRef.current.hasSignerProvider !== hasSignerProvider
  ) {
    identityRef.current = {
      storagePrefix,
      clientStoreName,
      signerConnected,
      hasSignerProvider,
    };
    generationRef.current += 1;
  }
  const identity = identityRef.current;
  const generation = generationRef.current;
  const keyPrefix =
    clientStoreName !== null
      ? `${storagePrefix}:${clientStoreName}`
      : hasSignerProvider
        ? null
        : storagePrefix;
  const accountIdKey = keyPrefix === null ? null : `${keyPrefix}:accountId`;
  const readyKey = keyPrefix === null ? null : `${keyPrefix}:ready`;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const session = readSession(accountIdKey, readyKey);
    setSessionAccountId(session.accountId);
    setStep(session.ready ? "ready" : "idle");
    setError(null);
  }, [identity, accountIdKey, readyKey]);

  const initialize = useCallback(async () => {
    if (
      !mountedRef.current ||
      identityRef.current !== identity ||
      generationRef.current !== generation
    )
      return;
    if (!client || !isReady || accountIdKey === null || readyKey === null) {
      throw new Error("Miden client is not ready");
    }

    assertSignerConnected(signerConnected);
    const isClientCurrent = captureClientCurrency(client);
    const isCurrent = () =>
      mountedRef.current &&
      identityRef.current === identity &&
      generationRef.current === generation &&
      isClientCurrent();
    if (!isCurrent()) return;

    if (isBusyRef.current?.()) {
      throw new MidenError(
        "Session account initialization is already in progress.",
        { code: "OPERATION_BUSY" }
      );
    }

    isBusyRef.current = isCurrent;
    const fund = fundRef.current;
    setError(null);

    try {
      // Read this identity's storage even before its restore effect has run.
      let walletId = readSession(accountIdKey, readyKey).accountId;

      if (!walletId) {
        setStep("creating");

        const resolvedStorageMode = getStorageMode(storageMode);

        const wallet = await client.newWallet(resolvedStorageMode, authScheme);
        if (!isCurrent()) return;
        ensureAccountBech32(wallet);
        const accounts = await client.getAccounts();
        if (!isCurrent()) return;
        setAccounts(accounts);

        walletId = wallet.id().toString();
        setSessionAccountId(walletId);
        localStorage.setItem(accountIdKey, walletId);
      }

      // Step 2: Fund the session wallet
      setStep("funding");
      if (!isCurrent()) return;
      await fund(walletId);

      if (!isCurrent()) return;

      // Step 3: Wait for funding note and consume it
      setStep("consuming");
      await waitAndConsume(
        client as unknown as WaitAndConsumeClient,
        walletId,
        pollIntervalMs,
        maxWaitMs,
        isCurrent
      );

      if (!isCurrent()) return;

      // Done
      setStep("ready");
      localStorage.setItem(readyKey, "true");

      await sync();
      if (!isCurrent()) return;
    } catch (err) {
      if (isCurrent()) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        setStep("idle");
        throw error;
      }
    } finally {
      if (isBusyRef.current === isCurrent) isBusyRef.current = null;
    }
  }, [
    client,
    isReady,
    sync,
    identity,
    generation,
    signerConnected,
    accountIdKey,
    readyKey,
    storageMode,
    authScheme,
    pollIntervalMs,
    maxWaitMs,
    setAccounts,
  ]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    setResetVersion((version) => version + 1);
    setSessionAccountId(null);
    setStep("idle");
    setError(null);
    if (accountIdKey !== null) localStorage.removeItem(accountIdKey);
    if (readyKey !== null) localStorage.removeItem(readyKey);
  }, [accountIdKey, readyKey]);

  return {
    initialize,
    sessionAccountId,
    isReady: step === "ready",
    step,
    error,
    reset,
  };
}

function readSession(accountIdKey: string | null, readyKey: string | null) {
  if (accountIdKey === null || readyKey === null) {
    return { accountId: null, ready: false };
  }
  try {
    const accountId = localStorage.getItem(accountIdKey);
    const ready = localStorage.getItem(readyKey) === "true";
    if (accountId) {
      const validationId = parseAccountId(accountId);
      (validationId as { free?: () => void })?.free?.();
      return { accountId, ready };
    }
  } catch {
    localStorage.removeItem(accountIdKey);
    localStorage.removeItem(readyKey);
  }
  return { accountId: null, ready: false };
}

function getStorageMode(
  mode: "private" | "public"
): ReturnType<typeof AccountStorageMode.private> {
  switch (mode) {
    case "private":
      return AccountStorageMode.private();
    case "public":
      return AccountStorageMode.public();
    default:
      return AccountStorageMode.public();
  }
}

type WaitAndConsumeClient = {
  syncState: () => Promise<unknown>;
  getConsumableNotes: (accountId?: unknown) => Promise<ConsumableNoteRecord[]>;
  newConsumeTransactionRequest: (
    notes: unknown[],
    consumingAccountId: unknown
  ) => Promise<unknown>;
  submitNewTransaction: (
    accountId: unknown,
    request: unknown
  ) => Promise<unknown>;
};

async function waitAndConsume(
  client: WaitAndConsumeClient,
  walletId: string,
  pollIntervalMs: number,
  maxWaitMs: number,
  isCurrent: () => boolean
) {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    if (!isCurrent()) return;

    await (client as { syncState: () => Promise<unknown> }).syncState();

    if (!isCurrent()) return;

    const accountIdObj = parseAccountId(walletId);
    const accountIdHex = accountIdObj.toString();
    // One block-locked note would fail the whole consume transaction, and
    // waiting is the right answer for it, so keep only what is consumable now.
    const records = await client.getConsumableNotes(accountIdObj);
    if (!isCurrent()) return;
    const consumable = records.filter((record) =>
      isConsumableNow(record, accountIdHex)
    );
    if (consumable.length > 0) {
      const notes = consumable.map((c) => c.inputNoteRecord().toNote());
      // `accountIdObj` was consumed by getConsumableNotes above, which takes it
      // by value; naming the account here is what lets the request omit fee
      // conversion info for auth components that cannot read it.
      const freshAccountId = parseAccountId(walletId);
      const txRequest = await client.newConsumeTransactionRequest(
        notes,
        freshAccountId
      );
      // Building the request suspends, so re-check before submitting: a
      // cancellation landing in that window would otherwise still submit, and
      // the caller's catch discards the outcome once cancelled.
      if (!isCurrent()) return;
      await client.submitNewTransaction(freshAccountId, txRequest);
      if (!isCurrent()) return;
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    if (!isCurrent()) return;
  }

  throw new Error("Timeout waiting for session wallet funding");
}
