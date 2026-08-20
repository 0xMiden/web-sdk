import { NoteType, TransactionFilter } from "@miden-sdk/miden-sdk";
import type {
  Note,
  TransactionId,
  TransactionRequest,
  WasmWebClient as WebClient,
} from "@miden-sdk/miden-sdk";

/** A request, or a factory that builds one from the client. */
export type TransactionRequestInput =
  | TransactionRequest
  | ((client: WebClient) => TransactionRequest | Promise<TransactionRequest>);

/** Resolves the factory form of a transaction request to a concrete request. */
export async function resolveTransactionRequest(
  request: TransactionRequestInput,
  client: WebClient
): Promise<TransactionRequest> {
  const resolved =
    typeof request === "function" ? await request(client) : request;
  // Passing a nullish request into wasm surfaces as "null pointer passed to
  // rust", which reads like a consumed handle and sends the reader hunting in
  // the wrong place.
  if (resolved == null) {
    throw new Error(
      typeof request === "function"
        ? "the transaction request factory returned null or undefined"
        : "a transaction request is required"
    );
  }
  return resolved;
}

/**
 * Reject an `anchor` that is present but falsy — except `undefined`, which is
 * how an optional property spells "absent".
 *
 * Anchored branches are selected by truthiness, so `{ anchor: null }` would
 * otherwise execute at the current tip: the one outcome anchoring exists to
 * prevent. It is easy to hit, because `useChainAnchor().anchor` is `null` until
 * the capture resolves, and `cond && anchor` yields `false`.
 */
export function assertAnchorValueUsable(options: { anchor?: unknown }): void {
  const { anchor } = options;
  if (anchor === undefined || anchor) return;
  throw new Error(
    `anchor was ${anchor === null ? "null" : JSON.stringify(anchor)}; await ` +
      "captureAnchor(request) before passing it, or omit the option entirely " +
      "to execute at the current tip"
  );
}

type ClientWithTransactions = {
  syncState: () => Promise<unknown>;
  getTransactions: (filter: TransactionFilter) => Promise<
    Array<{
      id: () => { toHex: () => string };
      transactionStatus: () => {
        isPending: () => boolean;
        isCommitted: () => boolean;
        isDiscarded: () => boolean;
      };
    }>
  >;
};

export async function waitForTransactionCommit(
  client: ClientWithTransactions,
  runExclusiveSafe: <T>(fn: () => Promise<T>) => Promise<T>,
  txId: TransactionId,
  maxWaitMs = 10_000,
  delayMs = 1_000
) {
  let waited = 0;

  while (waited < maxWaitMs) {
    await runExclusiveSafe(() => client.syncState());
    const [record] = await runExclusiveSafe(() =>
      client.getTransactions(TransactionFilter.ids([txId]))
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
    waited += delayMs;
  }

  throw new Error("Timeout waiting for transaction commit");
}

export function extractFullNotes(txResult: unknown): Note[] {
  try {
    const executedTx = (
      txResult as { executedTransaction?: () => unknown }
    ).executedTransaction?.() as {
      outputNotes?: () => {
        notes?: () => Array<{
          noteType?: () => NoteType;
          intoFull?: () => Note | null;
        }>;
      };
    };
    const notes = executedTx?.outputNotes?.().notes?.() ?? [];
    const result: Note[] = [];
    for (const note of notes) {
      if (note.noteType?.() === NoteType.Private) {
        const full = note.intoFull?.();
        if (full) result.push(full);
      }
    }
    return result;
  } catch {
    return [];
  }
}

export function extractFullNote(txResult: unknown): Note | null {
  try {
    const executedTx = (
      txResult as { executedTransaction?: () => unknown }
    ).executedTransaction?.() as {
      outputNotes?: () => {
        notes?: () => Array<{ intoFull?: () => Note | null }>;
      };
    };
    const notes = executedTx?.outputNotes?.().notes?.() ?? [];
    const note = notes[0];
    return note?.intoFull?.() ?? null;
  } catch {
    return null;
  }
}
