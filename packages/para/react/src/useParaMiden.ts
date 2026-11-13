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
 * Spawns the client once a Para session with at least one EVM wallet is active.
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
  const clientRef = useRef<MidenClient | null>(null);
  // Which EVM wallets the client in clientRef was built for, so a logout or a
  // different Para user does not keep using the previous user's client.
  const clientWalletKeyRef = useRef<string>("");
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

  useEffect(() => {
    let cancelled = false;

    const dropClient = () => {
      clientRef.current?.terminate();
      clientRef.current = null;
      clientWalletKeyRef.current = "";
      setAccountId("");
      setError("");
    };

    async function setupClient() {
      if (!isConnected || !para || !embedded.wallets?.length) {
        if (clientRef.current) {
          dropClient();
        }
        return;
      }

      if (clientRef.current) {
        if (clientWalletKeyRef.current === walletKey) {
          return;
        }
        dropClient();
      }

      try {
        const { client: midenParaClient, accountId: aId } =
          await createParaMidenClient(
            para,
            evmWallets as Wallet[],
            {
              ...opts,
              endpoint: nodeUrl,
              storageMode,
            },
            showSigningModal,
            customSignConfirmStep
          );

        if (cancelled) {
          // Never handed out, so nothing else would terminate it.
          midenParaClient.terminate();
          return;
        }

        clientRef.current = midenParaClient;
        clientWalletKeyRef.current = walletKey;
        setAccountId(aId);
        setError("");
      } catch (err) {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    setupClient();

    return () => {
      cancelled = true;
    };
  }, [
    isConnected,
    evmWallets,
    walletKey,
    para,
    nodeUrl,
    showSigningModal,
    customSignConfirmStep,
  ]);

  return {
    client: clientRef.current,
    accountId,
    error,
    para,
    evmWallets,
    nodeUrl,
    opts,
  };
}
