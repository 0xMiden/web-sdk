import { useCallback, useEffect } from "react";
import { useMiden } from "../context/MidenProvider";
import { useMidenStore, useAccountsStore } from "../store/MidenStore";
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
  const setLoadingAccounts = useMidenStore((state) => state.setLoadingAccounts);
  const setAccounts = useMidenStore((state) => state.setAccounts);

  const refetch = useCallback(async () => {
    if (!client || !isReady) return;

    setLoadingAccounts(true);
    try {
      const fetchedAccounts = await client.getAccounts();
      setAccounts(fetchedAccounts);
    } catch (error) {
      console.error("Failed to fetch accounts:", error);
    } finally {
      setLoadingAccounts(false);
    }
  }, [client, isReady, setAccounts, setLoadingAccounts]);

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
