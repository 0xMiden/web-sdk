import type { NoteConsumability } from "@miden-sdk/miden-sdk";
import type { NoteConsumabilityStatus } from "../types";

/**
 * Reduce screener entries, from `client.getNoteConsumability` or
 * `ConsumableNoteRecord.noteConsumability()`, to one status: `immediately`
 * when an entry is consumable now, else `afterBlock` with the earliest unlock
 * height, else `never`. An empty array is `never`: the screener leaves out
 * accounts that cannot consume the note.
 *
 * @param entries - The screener's entries for the note.
 * @param accountIdHex - Count only this account's entries.
 */
export function getNoteConsumabilityStatus(
  entries: NoteConsumability[],
  accountIdHex?: string
): NoteConsumabilityStatus {
  let unlockHeight: number | undefined;
  for (const entry of entries) {
    if (accountIdHex != null && entry.accountId().toString() !== accountIdHex) {
      continue;
    }
    const status = entry.consumptionStatus();
    if (status.isConsumableNow()) return { kind: "immediately" };
    const height = status.consumableAfterBlock();
    if (height != null && (unlockHeight == null || height < unlockHeight)) {
      unlockHeight = height;
    }
  }
  return unlockHeight == null
    ? { kind: "never" }
    : { kind: "afterBlock", blockHeight: unlockHeight };
}
