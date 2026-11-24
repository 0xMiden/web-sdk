import type { NoteConsumability } from "@miden-sdk/miden-sdk";
import type { NoteConsumabilityStatus } from "../types";

export function getNoteConsumabilityStatus(
  _entries: NoteConsumability[],
  _accountIdHex?: string
): NoteConsumabilityStatus {
  return { kind: "never" };
}
