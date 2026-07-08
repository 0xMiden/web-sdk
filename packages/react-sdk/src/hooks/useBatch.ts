import { useCallback, useRef, useState } from "react";
import { BatchItem } from "@miden-sdk/miden-sdk";
import { useMiden } from "../context/MidenProvider";
import type { BatchOptions, BatchResult, TransactionStage } from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { MidenError, assertSignerConnected } from "../utils/errors";

export interface UseBatchResult {
  /** Submit a multi-transaction batch atomically. */
  batch: (options: BatchOptions) => Promise<BatchResult>;
  /** The batch result. */
  result: BatchResult | null;
  /** Whether the batch submission is in progress. */
  isLoading: boolean;
  /** Current stage. `proving` is skipped — proving happens inside the batch primitive. */
  stage: TransactionStage;
  /** Error if the batch failed. */
  error: Error | null;
  /** Reset the hook state. */
  reset: () => void;
}

/**
 * Hook for atomic multi-transaction batches across one or more local accounts.
 *
 * Each item pairs a tracked local account with a pre-built `TransactionRequest`.
 * The batch is proven and submitted atomically — either every tx lands or none.
 * A later tx may consume a note produced by an earlier one (even across accounts);
 * push order must respect producer-before-consumer.
 *
 * @example
 * ```tsx
 * function BatchButton() {
 *   const { batch, isLoading } = useBatch();
 *   const client = useMidenClient();
 *
 *   const handleBatch = async () => {
 *     const reqSend = await client.newSendTransactionRequest(
 *       alice, bob, token, NoteType.Private, 50n, null, null
 *     );
 *     const reqConsume = await client.newConsumeTransactionRequest([note]);
 *     const { blockNumber } = await batch({
 *       items: [
 *         { account: alice, request: reqSend },
 *         { account: bob, request: reqConsume },
 *       ],
 *     });
 *     console.log("landed in block", blockNumber);
 *   };
 *
 *   return <button onClick={handleBatch} disabled={isLoading}>Submit batch</button>;
 * }
 * ```
 */
export function useBatch(): UseBatchResult {
  const { client, isReady, sync, signerConnected } = useMiden();
  const isBusyRef = useRef(false);

  const [result, setResult] = useState<BatchResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stage, setStage] = useState<TransactionStage>("idle");
  const [error, setError] = useState<Error | null>(null);

  const batch = useCallback(
    async (options: BatchOptions): Promise<BatchResult> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }
      assertSignerConnected(signerConnected);

      if (!options.items || options.items.length === 0) {
        throw new Error("useBatch: `items` must be a non-empty array");
      }

      if (isBusyRef.current) {
        throw new MidenError(
          "A batch is already in progress. Await the previous batch before starting another.",
          { code: "BATCH_BUSY" }
        );
      }

      isBusyRef.current = true;
      setIsLoading(true);
      setStage("executing");
      setError(null);

      try {
        if (!options.skipSync) {
          await sync();
        }

        const wasmItems = options.items.map((item, i) => {
          if (!item?.account) {
            throw new Error(`useBatch: items[${i}] is missing \`account\``);
          }
          if (!item?.request) {
            throw new Error(`useBatch: items[${i}] is missing \`request\``);
          }
          // Fresh AccountId per item — wasm-bindgen consumes Vec<BatchItem>'s
          // entries, so reusing the same JS proxy across items would invalidate
          // earlier ones.
          const accountId = parseAccountId(item.account);
          return new BatchItem(accountId, item.request as never);
        });

        setStage("submitting");
        const blockNumber = await (
          client as unknown as {
            submitNewTransactionBatch: (items: BatchItem[]) => Promise<number>;
          }
        ).submitNewTransactionBatch(wasmItems);

        const summary: BatchResult = { blockNumber };
        setStage("complete");
        setResult(summary);

        await sync();
        return summary;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setStage("idle");
        throw e;
      } finally {
        setIsLoading(false);
        isBusyRef.current = false;
      }
    },
    [client, isReady, signerConnected, sync]
  );

  const reset = useCallback(() => {
    setResult(null);
    setIsLoading(false);
    setStage("idle");
    setError(null);
  }, []);

  return { batch, result, isLoading, stage, error, reset };
}
