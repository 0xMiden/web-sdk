import type { Note } from "@miden-sdk/miden-sdk";
import type {
  NoteConsumabilityOptions,
  NoteConsumabilityResult,
} from "../types";

export function useNoteConsumability(
  _note: Note | null | undefined,
  _options?: NoteConsumabilityOptions
): NoteConsumabilityResult {
  return {
    status: null,
    consumability: null,
    isLoading: false,
    error: null,
    refetch: async () => {},
  };
}
