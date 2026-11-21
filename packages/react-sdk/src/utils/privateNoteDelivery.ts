import { NoteType } from "@miden-sdk/miden-sdk";
import type { Address } from "@miden-sdk/miden-sdk";
import { parseAccountId, parseAddress } from "./accountParsing";
import type { AccountRef } from "./accountParsing";
import { PrivateNoteDeliveryError } from "./errors";
import type { PrivateNoteDelivery } from "./errors";
import {
  TransactionDiscardedError,
  waitForTransactionCommit,
} from "./transactionCommit";
import type { ClientWithTransactions } from "./transactionCommit";

type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>;

type ClientWithRelay = {
  sendPrivateOutputNote: (noteId: string, address: Address) => Promise<void>;
};

/** The notes a hook owes, read once its transaction is submitted. */
type OwedPrivateNotes =
  | { notes: PrivateNoteDelivery[]; unreadable?: undefined }
  | { notes: []; unreadable: { cause: unknown } };

type OutputNoteHeader = {
  id: () => { toString: () => string };
  metadata: () => { noteType: () => NoteType };
};

/**
 * Names a recipient in a form `parseAddress` accepts again, so a delivery
 * report can be resent: a string as given, an object by its account id.
 */
export function recipientRef(to: AccountRef): string {
  return typeof to === "string" ? to : parseAccountId(to).toString();
}

/**
 * Reads what a hook owes once its transaction is submitted, turning a failure
 * to read into a report rather than an empty list: an unreadable transaction
 * must not pass for one that created no private notes.
 */
export function readOwedPrivateNotes(
  read: () => PrivateNoteDelivery[]
): OwedPrivateNotes {
  try {
    return { notes: read() };
  } catch (cause) {
    return { notes: [], unreadable: { cause } };
  }
}

// Only `userOutputNotes` is read: the unsplit `outputNotes` also holds the
// kernel's fee note, which is never the caller's to deliver. A result without
// the accessor throws here, so it is reported as unreadable.
function userOutputNotes(txResult: unknown): OutputNoteHeader[] {
  const executed = (
    txResult as { executedTransaction: () => unknown }
  ).executedTransaction() as { userOutputNotes: () => OutputNoteHeader[] };
  return executed.userOutputNotes();
}

/**
 * The private output notes a transaction created, each owed to `to` by the id
 * on its header. Whether this client holds a note's details is for the relay to
 * decide: `sendPrivateOutputNote` rejects a note it cannot send, which then
 * lands in `undelivered` like any other failed relay.
 */
export function privateOutputNotesOwed(
  txResult: unknown,
  to: string
): PrivateNoteDelivery[] {
  return userOutputNotes(txResult)
    .filter((note) => note.metadata().noteType() === NoteType.Private)
    .map((note) => ({ noteId: note.id().toString(), to }));
}

/** The one note a send transaction created, owed to `to`. */
export function sentNoteOwed(
  txResult: unknown,
  to: string
): PrivateNoteDelivery[] {
  const [note] = userOutputNotes(txResult);
  if (!note) {
    throw new Error("The send transaction created no output note");
  }
  return [{ noteId: note.id().toString(), to }];
}

/**
 * Relays each note through `runExclusiveSafe`, attempting every one whatever
 * happened to the previous. `sendPrivateOutputNote` takes the address by value,
 * so each call parses its own.
 */
export async function deliverPrivateNotes(
  client: ClientWithRelay,
  runExclusiveSafe: RunExclusive,
  notes: PrivateNoteDelivery[]
): Promise<{
  delivered: PrivateNoteDelivery[];
  undelivered: PrivateNoteDelivery[];
  firstError: unknown;
}> {
  const delivered: PrivateNoteDelivery[] = [];
  const undelivered: PrivateNoteDelivery[] = [];
  let firstError: unknown;
  for (const { noteId, to } of notes) {
    try {
      await runExclusiveSafe(() =>
        client.sendPrivateOutputNote(noteId, parseAddress(to))
      );
      delivered.push({ noteId, to });
    } catch (err) {
      if (undelivered.length === 0) firstError = err;
      undelivered.push({ noteId, to });
    }
  }
  return { delivered, undelivered, firstError };
}

/**
 * Finishes a submitted transaction that owes private notes: applies it, waits
 * for it to commit and relays every note, rejecting with a
 * `PrivateNoteDeliveryError` that keeps the transaction id whenever an owed
 * note is not delivered. A discarded transaction is a plain error: it never
 * landed, so it owes nothing. With nothing owed, every failure stays plain.
 */
export async function settlePrivateNotes({
  client,
  runExclusiveSafe,
  transactionId,
  owed,
  apply,
}: {
  client: ClientWithRelay & ClientWithTransactions;
  runExclusiveSafe: RunExclusive;
  transactionId: string;
  owed: OwedPrivateNotes;
  apply: () => Promise<unknown>;
}): Promise<void> {
  const all = owed.notes;
  const fail = (
    commitment: "committed" | "unknown",
    delivered: PrivateNoteDelivery[],
    undelivered: PrivateNoteDelivery[],
    cause: unknown
  ) =>
    new PrivateNoteDeliveryError({
      transactionId,
      commitment,
      delivered,
      undelivered,
      cause,
    });

  try {
    await apply();
  } catch (cause) {
    if (all.length === 0 && !owed.unreadable) throw cause;
    throw fail("unknown", [], all, cause);
  }
  if (owed.unreadable) throw fail("unknown", [], [], owed.unreadable.cause);

  try {
    await waitForTransactionCommit(client, runExclusiveSafe, transactionId);
  } catch (cause) {
    if (all.length === 0 || cause instanceof TransactionDiscardedError) {
      throw cause;
    }
    throw fail("unknown", [], all, cause);
  }

  const { delivered, undelivered, firstError } = await deliverPrivateNotes(
    client,
    runExclusiveSafe,
    all
  );
  if (undelivered.length > 0) {
    throw fail("committed", delivered, undelivered, firstError);
  }
}
