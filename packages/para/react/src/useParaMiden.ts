"use client";

import { useClient, useAccount, type Wallet } from "@getpara/react-sdk-lite";
import type { MidenClient } from "@miden-sdk/miden-sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createParaMidenClient,
  type Opts,
  type MidenAccountStorageMode,
  type CustomSignConfirmStep,
} from "@miden-sdk/para";

/**
 * React hook that converts Para React SDK context into a ready-to-use MidenClient.
 * Spawns the client once a Para session with at least one EVM wallet is active,
 * and terminates it on logout, on an EVM wallet change, on a client config change
 * (`nodeUrl`, `storageMode`, the `opts` fields, `showSigningModal`, or whether
 * `customSignConfirmStep` is set), and on unmount. A new reference for `para`,
 * the wallets, `opts`, or `customSignConfirmStep` with the same values does not
 * rebuild the client; the latest `customSignConfirmStep` is always the one called.
 * Setups run one at a time: a superseded setup finishes and its client is
 * terminated before the next one starts.
 *
 * Returns:
 * - client: MidenClient instance backed by the active Para session (or null while loading)
 * - accountId: Miden account id derived for the selected EVM wallet
 * - error: message if client setup failed after Para connected
 * - para: Para client instance from context
 * - evmWallets: filtered list of Para wallets with type === 'EVM'
 * - nodeUrl: Miden node endpoint used for the client
 * - opts: forwarded options used when creating the client
 * - showSigningModal: toggles the built-in signing modal
 * - customSignConfirmStep: optional callback for custom transaction confirmation flows
 */
export function useParaMiden(
  nodeUrl: string,
  storageMode: MidenAccountStorageMode = "public",
  opts: Omit<Opts, "endpoint" | "storageMode"> = {},
  showSigningModal: boolean = true,
  customSignConfirmStep?: CustomSignConfirmStep
) {
  const para = useClient();
  const { isConnected, embedded } = useAccount();
  const [client, setClient] = useState<MidenClient | null>(null);
  const [accountId, setAccountId] = useState<string>("");
  const [error, setError] = useState<string>("");

  const evmWallets = useMemo(
    () => embedded.wallets?.filter((wallet) => wallet.type === "EVM"),
    [embedded.wallets]
  );
  const walletKey = useMemo(
    () => (evmWallets ?? []).map((wallet) => wallet.id).join(","),
    [evmWallets]
  );

  // Latest values, read when a setup starts, so a new reference with the same
  // contents does not restart setup.
  const paraRef = useRef(para);
  paraRef.current = para;
  const evmWalletsRef = useRef(evmWallets);
  evmWalletsRef.current = evmWallets;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const customSignConfirmStepRef = useRef(customSignConfirmStep);
  customSignConfirmStepRef.current = customSignConfirmStep;
  // The previous setup, so the next one starts only after it has settled and
  // terminated any client it built after being superseded.
  const setupRef = useRef<Promise<void>>(Promise.resolve());

  const hasPara = Boolean(para);
  const hasWallets = Boolean(embedded.wallets?.length);
  const hasCustomSignConfirmStep = Boolean(customSignConfirmStep);
  const { accountSeed, noteTransportUrl, nodeTransportUrl, seed } = opts;

  useEffect(() => {
    setClient(null);
    setAccountId("");
    setError("");

    if (!isConnected || !hasPara || !hasWallets) {
      return;
    }

    let cancelled = false;
    let createdClient: MidenClient | null = null;

    const confirmStep: CustomSignConfirmStep | undefined =
      hasCustomSignConfirmStep
        ? async (txSummaryJson) =>
            customSignConfirmStepRef.current?.(txSummaryJson)
        : undefined;

    async function setupClient() {
      const currentPara = paraRef.current;
      if (cancelled || !currentPara) {
        return;
      }

      try {
        const { client: midenParaClient, accountId: aId } =
          await createParaMidenClient(
            currentPara,
            evmWalletsRef.current as Wallet[],
            {
              ...optsRef.current,
              endpoint: nodeUrl,
              storageMode,
            },
            showSigningModal,
            confirmStep
          );

        if (cancelled) {
          // Never handed out, so nothing else would terminate it.
          midenParaClient.terminate();
          return;
        }

        createdClient = midenParaClient;
        setClient(midenParaClient);
        setAccountId(aId);
      } catch (err) {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    setupRef.current = setupRef.current.then(setupClient);

    return () => {
      cancelled = true;
      createdClient?.terminate();
      createdClient = null;
    };
  }, [
    isConnected,
    hasPara,
    hasWallets,
    walletKey,
    nodeUrl,
    storageMode,
    accountSeed,
    noteTransportUrl,
    nodeTransportUrl,
    seed,
    showSigningModal,
    hasCustomSignConfirmStep,
  ]);

  return {
    client,
    accountId,
    error,
    para,
    evmWallets,
    nodeUrl,
    opts,
  };
}
