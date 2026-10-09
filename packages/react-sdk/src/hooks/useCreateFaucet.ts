import { useCallback, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import { useMidenStore } from "../store/MidenStore";
import { AccountStorageMode } from "@miden-sdk/miden-sdk";
import type { Account } from "@miden-sdk/miden-sdk";
import type { CreateFaucetOptions } from "../types";
import { DEFAULTS } from "../types";
import { runExclusiveDirect } from "../utils/runExclusive";

export interface UseCreateFaucetResult {
  /** Create a new faucet with the specified options */
  createFaucet: (options: CreateFaucetOptions) => Promise<Account>;
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
 * Hook to create a new faucet account.
 *
 * Pass `nonFungible: true` for a faucet that mints `NonFungibleAsset`s. A
 * non-fungible faucet takes no `decimals` or `maxSupply`; passing either throws.
 *
 * @example
 * ```tsx
 * function CreateFaucetButton() {
 *   const { createFaucet, faucet, isCreating, error } = useCreateFaucet();
 *
 *   const handleCreate = async () => {
 *     const newFaucet = await createFaucet({
 *       tokenSymbol: 'TEST',
 *       decimals: 8,
 *       maxSupply: 1000000n * 10n ** 8n, // 1M tokens
 *     });
 *     console.log('Created faucet:', newFaucet.id().toString());
 *   };
 *
 *   const handleCreateNft = () =>
 *     createFaucet({ nonFungible: true, tokenSymbol: 'ART' });
 *
 *   return (
 *     <div>
 *       <button onClick={handleCreate} disabled={isCreating}>
 *         {isCreating ? 'Creating...' : 'Create Faucet'}
 *       </button>
 *       {faucet && <p>Created: {faucet.id().toString()}</p>}
 *       {error && <p>Error: {error.message}</p>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useCreateFaucet(): UseCreateFaucetResult {
  const { client, isReady, runExclusive } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;
  const setAccounts = useMidenStore((state) => state.setAccounts);

  const [faucet, setFaucet] = useState<Account | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const createFaucet = useCallback(
    async (options: CreateFaucetOptions): Promise<Account> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      setIsCreating(true);
      setError(null);

      try {
        const nonFungible = options.nonFungible === true;
        if (
          nonFungible &&
          (options.decimals !== undefined || options.maxSupply !== undefined)
        ) {
          throw new Error(
            "decimals and maxSupply only apply to fungible faucets"
          );
        }

        const storageMode = getStorageMode(
          options.storageMode ?? DEFAULTS.STORAGE_MODE
        );
        // The client ignores decimals and maxSupply for a non-fungible faucet.
        const decimals = nonFungible
          ? 0
          : (options.decimals ?? DEFAULTS.FAUCET_DECIMALS);
        const maxSupply = nonFungible ? 0n : BigInt(options.maxSupply);
        const authScheme = options.authScheme ?? DEFAULTS.AUTH_SCHEME;

        const newFaucet = await runExclusiveSafe(async () => {
          const createdFaucet = await client.newFaucet(
            storageMode,
            nonFungible,
            options.tokenName ?? options.tokenSymbol,
            options.tokenSymbol,
            decimals,
            maxSupply,
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
    createFaucet,
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
