import { TransactionFilter, TransactionId } from "@miden-sdk/miden-sdk";

type ClientWithTransactions = {
  syncState: () => Promise<unknown>;
  getTransactions: (filter: TransactionFilter) => Promise<
    Array<{
      transactionStatus: () => {
        isPending: () => boolean;
        isCommitted: () => boolean;
        isDiscarded: () => boolean;
      };
    }>
  >;
};

/**
 * Poll until a transaction is committed or discarded.
 *
 * Takes the id as hex and builds a fresh `TransactionId` for every poll:
 * `TransactionFilter.ids` takes its handles by value, so a handle that has been
 * through one poll is gone and a second poll with it fails.
 */
export async function waitForTransactionCommit(
  client: ClientWithTransactions,
  runExclusiveSafe: <T>(fn: () => Promise<T>) => Promise<T>,
  txIdHex: string,
  maxWaitMs = 10_000,
  delayMs = 1_000
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  const targetHex = normalizeTransactionIdHex(txIdHex);

  while (Date.now() < deadline) {
    await runExclusiveSafe(() => client.syncState());
    const [record] = await runExclusiveSafe(() =>
      client.getTransactions(
        TransactionFilter.ids([TransactionId.fromHex(targetHex)])
      )
    );
    if (record) {
      const status = record.transactionStatus();
      if (status.isCommitted()) {
        return;
      }
      if (status.isDiscarded()) {
        throw new Error("Transaction was discarded before commit");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("Timeout waiting for transaction commit");
}

/** `TransactionId.fromHex` wants a `0x` prefix. */
function normalizeTransactionIdHex(value: string): string {
  const trimmed = value.trim();
  const normalized =
    trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? trimmed
      : `0x${trimmed}`;
  return normalized.toLowerCase();
}

export type { ClientWithTransactions };
