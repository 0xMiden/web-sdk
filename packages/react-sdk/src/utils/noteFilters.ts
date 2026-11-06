import { NoteFilterTypes, NoteType } from "@miden-sdk/miden-sdk";

/**
 * Map a status string to the corresponding NoteFilterTypes enum value.
 * Shared between useNotes and useNoteStream.
 */
export function getNoteFilterType(
  status?: "all" | "consumed" | "committed" | "expected" | "processing"
): NoteFilterTypes {
  switch (status) {
    case "consumed":
      return NoteFilterTypes.Consumed;
    case "committed":
      return NoteFilterTypes.Committed;
    case "expected":
      return NoteFilterTypes.Expected;
    case "processing":
      return NoteFilterTypes.Processing;
    case "all":
    default:
      return NoteFilterTypes.All;
  }
}

/**
 * Map a note type string to the corresponding NoteType enum value.
 * Shared across hooks that create transactions (useSend, useMultiSend, etc.).
 */
export function getNoteType(type: "private" | "public"): NoteType {
  switch (type) {
    case "private":
      return NoteType.Private;
    case "public":
      return NoteType.Public;
    default:
      return NoteType.Private;
  }
}
