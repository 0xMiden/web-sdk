import { describe, it, expect } from "vitest";
import type { InputNoteRecord, NoteAttachment } from "@miden-sdk/miden-sdk";
import {
  readNoteAttachment,
  createNoteAttachment,
  emptyAttachment,
} from "../../utils/noteAttachment";

// `readNoteAttachment` only touches `record.attachments()`, so a minimal stub
// carrying the mocked `NoteAttachment` objects (which round-trip their words via
// `toWords()`, backed by the `Word` mock's `toU64s()`) exercises the genuine
// decode path without standing up a full client.
function recordWith(attachments: NoteAttachment[]): InputNoteRecord {
  return {
    attachments: () => attachments,
  } as unknown as InputNoteRecord;
}

describe("readNoteAttachment", () => {
  it("returns null when the note has no attachments", () => {
    expect(readNoteAttachment(recordWith([]))).toBeNull();
  });

  it("returns null for the empty-attachment placeholder", () => {
    expect(readNoteAttachment(recordWith([emptyAttachment()]))).toBeNull();
  });

  it("decodes a single-word attachment as kind 'word'", () => {
    const result = readNoteAttachment(
      recordWith([createNoteAttachment([1n, 2n, 3n])])
    );
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("word");
    // Padded to the word boundary with a trailing zero.
    expect(result!.values).toEqual([1n, 2n, 3n, 0n]);
  });

  it("decodes a multi-word attachment as kind 'array'", () => {
    const result = readNoteAttachment(
      recordWith([createNoteAttachment([1n, 2n, 3n, 4n, 5n])])
    );
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("array");
    // Padded to two whole words.
    expect(result!.values).toEqual([1n, 2n, 3n, 4n, 5n, 0n, 0n, 0n]);
  });

  it("round-trips a full four-value word without padding", () => {
    const result = readNoteAttachment(
      recordWith([createNoteAttachment([10n, 20n, 30n, 40n])])
    );
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("word");
    expect(result!.values).toEqual([10n, 20n, 30n, 40n]);
  });

  it("returns null when the accessor throws", () => {
    const broken = {
      attachments: () => {
        throw new Error("boom");
      },
    } as unknown as InputNoteRecord;
    expect(readNoteAttachment(broken)).toBeNull();
  });
});

describe("createNoteAttachment", () => {
  it("falls back to a placeholder attachment for empty input", () => {
    expect(() => createNoteAttachment([])).not.toThrow();
    expect(createNoteAttachment([])).toBeDefined();
  });

  it("creates a Word attachment for 1-4 values", () => {
    const attachment = createNoteAttachment([1n, 2n]);
    expect(attachment).toBeDefined();
    expect(attachment.numWords()).toBe(1);
  });

  it("pads to 4 elements without throwing for 1-4 values", () => {
    expect(() => createNoteAttachment([1n])).not.toThrow();
    expect(() => createNoteAttachment([1n, 2n, 3n])).not.toThrow();
    expect(() => createNoteAttachment([1n, 2n, 3n, 4n])).not.toThrow();
  });

  it("creates a multi-Word attachment for > 4 values", () => {
    const attachment = createNoteAttachment([1n, 2n, 3n, 4n, 5n]);
    expect(attachment).toBeDefined();
    expect(attachment.numWords()).toBe(2);
  });

  it("accepts number[] input", () => {
    expect(() => createNoteAttachment([1, 2, 3])).not.toThrow();
  });

  it("accepts Uint8Array input", () => {
    expect(() => createNoteAttachment(new Uint8Array([1, 2, 3]))).not.toThrow();
  });

  it("pads multi-Word attachments to a multiple of 4", () => {
    expect(() => createNoteAttachment([1n, 2n, 3n, 4n, 5n])).not.toThrow();
    expect(() =>
      createNoteAttachment([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n])
    ).not.toThrow();
  });
});

describe("emptyAttachment", () => {
  it("returns a placeholder NoteAttachment built via fromWord", () => {
    expect(() => emptyAttachment()).not.toThrow();
    expect(emptyAttachment()).toBeDefined();
    expect(emptyAttachment().numWords()).toBe(1);
  });
});
