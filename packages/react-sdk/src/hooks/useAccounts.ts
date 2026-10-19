import { useCallback, useEffect } from "react";
import { useMiden } from "../context/MidenProvider";
import {
  captureClientCurrency,
  useMidenStore,
  useAccountsStore,
} from "../store/MidenStore";
import type { AccountsResult } from "../types";

/**
 * Hook to list all accounts in the client.
 *
 * @example
 * ```tsx
 * function AccountList() {
 *   const { accounts, wallets, faucets, isLoading } = useAccounts();
 *
 *   if (isLoading) return <div>Loading...</div>;
 *
 *   return (
 *     <div>
 *       <h2>Wallets ({wallets.length})</h2>
 *       {wallets.map(w => <div key={w.id().toString()}>{w.id().toString()}</div>)}
 *
 *       <h2>Faucets ({faucets.length})</h2>
 *       {faucets.map(f => <div key={f.id().toString()}>{f.id().toString()}</div>)}
 *     </div>
 *   );
 * }
 * ```
 */
export function useAccounts(): AccountsResult {
  const { client, isReady } = useMiden();
  const accounts = useAccountsStore();
  const isLoadingAccounts = useMidenStore((state) => state.isLoadingAccounts);
  const beginLoadingAccounts = useMidenStore(
    (state) => state.beginLoadingAccounts
  );
  const endLoadingAccounts = useMidenStore((state) => state.endLoadingAccounts);
  const setAccounts = useMidenStore((state) => state.setAccounts);

  const refetch = useCallback(async () => {
    if (!client || !isReady) return;

    const isCurrent = captureClientCurrency(client);
    if (!isCurrent()) return;

    const loadingToken = beginLoadingAccounts();

    try {
      const fetchedAccounts = await client.getAccounts();
      if (!isCurrent()) return;
      setAccounts(fetchedAccounts);
    } catch (error) {
      if (!isCurrent()) return;
      console.error("Failed to fetch accounts:", error);
    } finally {
      endLoadingAccounts(loadingToken);
    }
  }, [client, isReady, setAccounts, beginLoadingAccounts, endLoadingAccounts]);

  // Initial fetch
  useEffect(() => {
    if (isReady && accounts.length === 0) {
      refetch();
    }
  }, [isReady, accounts.length, refetch]);

  return {
    accounts,
    wallets: accounts,
    faucets: [],
    isLoading: isLoadingAccounts,
    error: null,
    refetch,
  };
}
