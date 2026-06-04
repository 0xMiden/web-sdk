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
 * Decode a note's attachment. Returns null if no attachment.
 *
 * Note: protocol 0.15 removed attachment content from `NoteMetadata` (only
 * attachment *headers* are carried there), so reading attachment payloads back
 * from a note record is not currently exposed by the SDK. This returns null
 * until an attachment accessor is added to `InputNoteRecord`.
 */
export function readNoteAttachment(
  _note: InputNoteRecord
): NoteAttachmentData | null {
  return null;
}

/**
 * Encode values into a NoteAttachment.
 *
 * In protocol 0.15 a note attachment's content is a list of words, so values
 * are packed into 4-element words (padded with trailing 0n to a word boundary).
 * `readNoteAttachment` would return raw values including padding, so consumers
 * should strip trailing zeros if they need the original unpadded values.
 *
 * Returns `undefined` for empty input, because protocol 0.15 has no empty
 * attachment (an attachment must carry at least one word). Pass the result
 * straight through to the note builders, which treat `undefined` as no
 * attachment.
 */
export function createNoteAttachment(
  values: bigint[] | Uint8Array | number[]
): NoteAttachment | undefined {
  const bigints: bigint[] = [];
  for (let i = 0; i < values.length; i++) {
    bigints.push(BigInt(values[i]));
  }

  if (bigints.length === 0) {
    return undefined;
  }

  while (bigints.length % 4 !== 0) {
    bigints.push(0n);
  }

  const words: Word[] = [];
  for (let i = 0; i < bigints.length; i += 4) {
    words.push(new Word(BigUint64Array.from(bigints.slice(i, i + 4))));
  }

  const scheme = NoteAttachmentScheme.none();
  return NoteAttachment.withWords(scheme, words);
}
