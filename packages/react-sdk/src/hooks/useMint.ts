import { useCallback, useState } from "react";
import type { AccountId, TransactionRequest } from "@miden-sdk/miden-sdk";
import { useMiden } from "../context/MidenProvider";
import type {
  MintNetworkNonFungibleOptions,
  MintNonFungibleOptions,
  MintOptions,
  TransactionStage,
  TransactionResult,
} from "../types";
import { DEFAULTS } from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { runExclusiveDirect } from "../utils/runExclusive";
import { getNoteType } from "../utils/noteFilters";

export interface UseMintResult {
  /** Mint tokens from a faucet to a target account */
  mint: (options: MintOptions) => Promise<TransactionResult>;
  /** The transaction result */
  result: TransactionResult | null;
  /** Whether the transaction is in progress */
  isLoading: boolean;
  /** Current stage of the transaction */
  stage: TransactionStage;
  /** Error if transaction failed */
  error: Error | null;
  /** Reset the hook state */
  reset: () => void;
}

export interface UseMintNonFungibleResult {
  /** Mint one non-fungible asset from a non-fungible faucet to a target account */
  mintNonFungible: (
    options: MintNonFungibleOptions
  ) => Promise<TransactionResult>;
  /** The transaction result */
  result: TransactionResult | null;
  /** Whether the transaction is in progress */
  isLoading: boolean;
  /** Current stage of the transaction */
  stage: TransactionStage;
  /** Error if transaction failed */
  error: Error | null;
  /** Reset the hook state */
  reset: () => void;
}

export interface UseMintNetworkNonFungibleResult {
  /** Mint one non-fungible asset from a network non-fungible faucet, as its owner */
  mintNetworkNonFungible: (
    options: MintNetworkNonFungibleOptions
  ) => Promise<TransactionResult>;
  /** The transaction result */
  result: TransactionResult | null;
  /** Whether the transaction is in progress */
  isLoading: boolean;
  /** Current stage of the transaction */
  stage: TransactionStage;
  /** Error if transaction failed */
  error: Error | null;
  /** Reset the hook state */
  reset: () => void;
}

/**
 * Hook to mint tokens from a faucet.
 *
 * @example
 * ```tsx
 * function MintButton({ faucetId, targetAccountId }: Props) {
 *   const { mint, isLoading, stage, error } = useMint();
 *
 *   const handleMint = async () => {
 *     try {
 *       const result = await mint({
 *         faucetId,
 *         targetAccountId,
 *         amount: 1000n,
 *       });
 *       console.log('Minted! TX:', result.transactionId);
 *     } catch (err) {
 *       console.error('Mint failed:', err);
 *     }
 *   };
 *
 *   return (
 *     <button onClick={handleMint} disabled={isLoading}>
 *       {isLoading ? stage : 'Mint Tokens'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useMint(): UseMintResult {
  return useMintAsset(buildFungibleMint);
}

/**
 * Hook to mint one non-fungible asset from a non-fungible faucet. The asset
 * must be issued by `faucetId`
 *
 * @example
 * ```tsx
 * const { mintNonFungible, isLoading } = useMintNonFungible();
 *
 * await mintNonFungible({
 *   faucetId,
 *   targetAccountId,
 *   nonFungibleAsset: NonFungibleAsset.fromData(
 *     AccountId.fromHex(faucetId),
 *     data, // the NFT's data, as bytes
 *     salt // a random Word; keep it with the data
 *   ),
 * });
 * ```
 */
export function useMintNonFungible(): UseMintNonFungibleResult {
  const { mint, ...state } = useMintAsset(buildNonFungibleMint);
  return { mintNonFungible: mint, ...state };
}

/**
 * Hook to mint one non-fungible asset from a network non-fungible faucet,
 * created with `useCreateNonFungibleFaucet({ owner })`. `owner` runs the
 * transaction: it sends the faucet a public MINT note, and the faucet mints the
 * asset into a public P2ID note for `targetAccountId` when the network consumes
 * that note. The faucet rejects a MINT note from any other sender.
 *
 * @example
 * ```tsx
 * const { mintNetworkNonFungible, isLoading } = useMintNetworkNonFungible();
 *
 * await mintNetworkNonFungible({
 *   owner,
 *   targetAccountId,
 *   nonFungibleAsset: NonFungibleAsset.fromData(networkFaucetId, data, salt),
 * });
 * ```
 */
export function useMintNetworkNonFungible(): UseMintNetworkNonFungibleResult {
  const { mint, ...state } = useMintAsset(buildNetworkNonFungibleMint);
  return { mintNetworkNonFungible: mint, ...state };
}

type MidenWebClient = NonNullable<ReturnType<typeof useMiden>["client"]>;

/**
 * Checks a mint's options and returns the account that runs the transaction and
 * the call that builds its request. The request is built under the WASM lock.
 */
type MintBuilder<O> = (
  client: MidenWebClient,
  options: O
) => {
  executingAccountId: AccountId;
  createRequest: () => Promise<TransactionRequest>;
};

/** Mints fungible tokens: the faucet runs the transaction. */
const buildFungibleMint: MintBuilder<MintOptions> = (client, options) => {
  const faucetId = parseAccountId(options.faucetId);
  const targetAccountId = parseAccountId(options.targetAccountId);
  const noteType = getNoteType(options.noteType ?? DEFAULTS.NOTE_TYPE);
  return {
    executingAccountId: faucetId,
    createRequest: () =>
      client.newMintTransactionRequest(
        targetAccountId,
        faucetId,
        noteType,
        BigInt(options.amount)
      ),
  };
};

/** Mints a non-fungible asset: the faucet that issues it runs the transaction. */
const buildNonFungibleMint: MintBuilder<MintNonFungibleOptions> = (
  client,
  options
) => {
  const nonFungibleAsset = options.nonFungibleAsset;
  if (!nonFungibleAsset) {
    throw new Error("mintNonFungible requires `nonFungibleAsset`");
  }
  const faucetId = parseAccountId(options.faucetId);
  if (nonFungibleAsset.faucetId().toString() !== faucetId.toString()) {
    throw new Error(
      "`nonFungibleAsset` must be issued by the faucet `faucetId`"
    );
  }
  const targetAccountId = parseAccountId(options.targetAccountId);
  const noteType = getNoteType(options.noteType ?? DEFAULTS.NOTE_TYPE);
  return {
    executingAccountId: faucetId,
    createRequest: () =>
      client.newMintNonFungibleTransactionRequest(
        targetAccountId,
        nonFungibleAsset,
        noteType
      ),
  };
};

/**
 * Mints from a network faucet: the owner runs the transaction, which only sends
 * the faucet a MINT note.
 */
const buildNetworkNonFungibleMint: MintBuilder<
  MintNetworkNonFungibleOptions
> = (client, options) => {
  const nonFungibleAsset = options.nonFungibleAsset;
  if (!nonFungibleAsset) {
    throw new Error("mintNetworkNonFungible requires `nonFungibleAsset`");
  }
  const owner = parseAccountId(options.owner);
  const targetAccountId = parseAccountId(options.targetAccountId);
  return {
    executingAccountId: owner,
    createRequest: () =>
      client.newNetworkMintNonFungibleTransactionRequest(
        owner,
        targetAccountId,
        nonFungibleAsset
      ),
  };
};

function useMintAsset<O>(buildRequest: MintBuilder<O>) {
  const { client, isReady, sync, runExclusive, prover } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;

  const [result, setResult] = useState<TransactionResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stage, setStage] = useState<TransactionStage>("idle");
  const [error, setError] = useState<Error | null>(null);

  const mint = useCallback(
    async (options: O): Promise<TransactionResult> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      setIsLoading(true);
      setStage("executing");
      setError(null);

      try {
        const { executingAccountId, createRequest } = buildRequest(
          client,
          options
        );

        setStage("proving");
        const txResult = await runExclusiveSafe(async () => {
          const txRequest = await createRequest();

          const txId = prover
            ? await client.submitNewTransactionWithProver(
                executingAccountId,
                txRequest,
                prover
              )
            : await client.submitNewTransaction(executingAccountId, txRequest);

          return { transactionId: txId.toHex() };
        });

        setStage("complete");
        setResult(txResult);

        await sync();

        return txResult;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        setStage("idle");
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [buildRequest, client, isReady, prover, runExclusive, sync]
  );

  const reset = useCallback(() => {
    setResult(null);
    setIsLoading(false);
    setStage("idle");
    setError(null);
  }, []);

  return {
    mint,
    result,
    isLoading,
    stage,
    error,
    reset,
  };
}
