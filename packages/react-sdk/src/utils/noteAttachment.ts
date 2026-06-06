import {
  NoteAttachment,
  NoteAttachmentScheme,
  Word,
} from "@miden-sdk/miden-sdk";
import type { InputNoteRecord } from "@miden-sdk/miden-sdk";

export interface NoteAttachmentData {
  values: bigint[];
  kind: "word" | "array";
}

/**
 * Decode a note's attachment payload back into the bigint values that
 * `createNoteAttachment` packed in.
 *
 * On the 0.15 protocol surface the full attachment content (the packed words)
 * lives on the note record (`InputNoteRecord.attachments()`), not on
 * `NoteMetadata`. This reads the note's first attachment and flattens its
 * words back into a `bigint[]`, the inverse of `createNoteAttachment`.
 *
 * - No attachments → `null`.
 * - The placeholder empty attachment produced by `emptyAttachment()` (a single
 *   all-zero word) → `null`, matching the pre-0.15 behavior where a `None`-kind
 *   attachment decoded to `null`.
 * - Otherwise → `{ values, kind }` where `kind` is `"word"` for a single-word
 *   attachment and `"array"` for multi-word content.
 *
 * The returned `values` include the trailing-zero padding `createNoteAttachment`
 * added to reach word boundaries; consumers that need the original unpadded
 * values should strip trailing zeros.
 */
export function readNoteAttachment(
  note: InputNoteRecord
): NoteAttachmentData | null {
  try {
    const attachments = note.attachments?.();
    if (!attachments || attachments.length === 0) return null;

    const words = attachments[0]!.toWords();
    if (words.length === 0) return null;

    const values: bigint[] = [];
    for (const word of words) {
      for (const value of word.toU64s()) {
        values.push(BigInt(value as number | bigint));
      }
    }

    // The empty-attachment placeholder (single all-zero word) is the 0.15
    // stand-in for "no attachment"; surface it as null so callers see the same
    // thing they did pre-migration for a None-kind attachment.
    if (values.every((value) => value === 0n)) return null;

    return { values, kind: words.length === 1 ? "word" : "array" };
  } catch {
    return null;
  }
}

/**
 * Encode bigint values into a `NoteAttachment`.
 *
 * - 0 values → falls back to `emptyAttachment()` (a single zero-Word
 *   attachment with the `none` scheme). On the 0.15 protocol surface there
 *   is no native "empty" attachment; this preserves the pre-migration
 *   "default attachment when caller has no payload" behavior at the cost
 *   of one trivial word.
 * - 1..=4 values → padded to 4 elements and wrapped as a single Word via
 *   `NoteAttachment.fromWord(scheme, word)`.
 * - >4 values → padded to a multiple of 4, chunked into Words, and wrapped
 *   via `NoteAttachment.fromWords(scheme, words)`.
 *
 * Values are padded to word boundaries (multiples of 4) with trailing `0n`.
 */
export function createNoteAttachment(
  values: bigint[] | Uint8Array | number[]
): NoteAttachment {
  const bigints: bigint[] = [];
  for (let i = 0; i < values.length; i++) {
    bigints.push(BigInt(values[i]!));
  }

  if (bigints.length === 0) {
    return emptyAttachment();
  }

  const scheme = NoteAttachmentScheme.none();

  if (bigints.length <= 4) {
    while (bigints.length < 4) {
      bigints.push(0n);
    }
    const word = new Word(BigUint64Array.from(bigints));
    return NoteAttachment.fromWord(scheme, word);
  }

  while (bigints.length % 4 !== 0) {
    bigints.push(0n);
  }
  const words: Word[] = [];
  for (let i = 0; i < bigints.length; i += 4) {
    words.push(new Word(BigUint64Array.from(bigints.slice(i, i + 4))));
  }
  return NoteAttachment.fromWords(scheme, words);
}

/**
 * Build a placeholder `NoteAttachment` for code paths that previously used
 * the now-private `new NoteAttachment()` empty constructor.
 *
 * The 0.15 protocol surface requires every note to carry at least one
 * attachment word; this helper produces a single-Word attachment with the
 * `none` scheme and all-zero content, which is the closest semantic to the
 * pre-0.15 "no attachment" notion while keeping `Note.createP2IDNote`
 * happy. Consumers that explicitly want a payload should call
 * `createNoteAttachment` with their values instead.
 */
export function emptyAttachment(): NoteAttachment {
  const scheme = NoteAttachmentScheme.none();
  const word = new Word(BigUint64Array.from([0n, 0n, 0n, 0n]));
  return NoteAttachment.fromWord(scheme, word);
}
