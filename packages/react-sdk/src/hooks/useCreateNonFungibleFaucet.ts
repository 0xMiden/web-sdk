import { useCallback, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import { useMidenStore } from "../store/MidenStore";
import { AccountStorageMode } from "@miden-sdk/miden-sdk";
import type { Account } from "@miden-sdk/miden-sdk";
import type { CreateNonFungibleFaucetOptions } from "../types";
import { DEFAULTS } from "../types";
import { runExclusiveDirect } from "../utils/runExclusive";

export interface UseCreateNonFungibleFaucetResult {
  /** Create a new non-fungible faucet with the specified options */
  createNonFungibleFaucet: (
    options: CreateNonFungibleFaucetOptions
  ) => Promise<Account>;
  /** The created faucet account */
  faucet: Account | null;
  /** Whether faucet creation is in progress */
  isCreating: boolean;
  /** Error if creation failed */
  error: Error | null;
  /** Reset the hook state */
  reset: () => void;
}

/**
 * Hook to create a non-fungible faucet account, which mints `NonFungibleAsset`s
 * with `useMintNonFungible`. Use `useCreateFaucet` for a fungible token faucet.
 *
 * @example
 * ```tsx
 * function CreateCollectionButton() {
 *   const { createNonFungibleFaucet, faucet, isCreating, error } =
 *     useCreateNonFungibleFaucet();
 *
 *   const handleCreate = () => createNonFungibleFaucet({ tokenSymbol: 'ART' });
 *
 *   return (
 *     <div>
 *       <button onClick={handleCreate} disabled={isCreating}>
 *         {isCreating ? 'Creating...' : 'Create Collection'}
 *       </button>
 *       {faucet && <p>Created: {faucet.id().toString()}</p>}
 *       {error && <p>Error: {error.message}</p>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useCreateNonFungibleFaucet(): UseCreateNonFungibleFaucetResult {
  const { client, isReady, runExclusive } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;
  const setAccounts = useMidenStore((state) => state.setAccounts);

  const [faucet, setFaucet] = useState<Account | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const createNonFungibleFaucet = useCallback(
    async (options: CreateNonFungibleFaucetOptions): Promise<Account> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      setIsCreating(true);
      setError(null);

      try {
        const storageMode = getStorageMode(
          options.storageMode ?? DEFAULTS.STORAGE_MODE
        );
        const authScheme = options.authScheme ?? DEFAULTS.AUTH_SCHEME;

        const newFaucet = await runExclusiveSafe(async () => {
          const createdFaucet = await client.newNonFungibleFaucet(
            storageMode,
            options.tokenName ?? options.tokenSymbol,
            options.tokenSymbol,
            authScheme
          );
          const accounts = await client.getAccounts();
          setAccounts(accounts);
          return createdFaucet;
        });

        setFaucet(newFaucet);

        return newFaucet;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setIsCreating(false);
      }
    },
    [client, isReady, runExclusive, setAccounts]
  );

  const reset = useCallback(() => {
    setFaucet(null);
    setIsCreating(false);
    setError(null);
  }, []);

  return {
    createNonFungibleFaucet,
    faucet,
    isCreating,
    error,
    reset,
  };
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
      return AccountStorageMode.private();
  }
}
