import { describe, it, expect } from "vitest";
import {
  readNoteAttachment,
  createNoteAttachment,
} from "../../utils/noteAttachment";

describe("readNoteAttachment", () => {
  // Protocol 0.15 removed attachment content from NoteMetadata, so attachment
  // payloads can no longer be read back from a note record.
  it("returns null", () => {
    const note = {} as unknown as Parameters<typeof readNoteAttachment>[0];
    expect(readNoteAttachment(note)).toBeNull();
  });
});

describe("createNoteAttachment", () => {
  it("returns undefined for empty values", () => {
    expect(createNoteAttachment([])).toBeUndefined();
  });

  it("creates an attachment for 1-4 values", () => {
    expect(createNoteAttachment([1n, 2n])).toBeDefined();
  });

  it("pads short inputs to a word boundary without throwing", () => {
    expect(() => createNoteAttachment([1n])).not.toThrow();
    expect(() => createNoteAttachment([1n, 2n, 3n])).not.toThrow();
    expect(() => createNoteAttachment([1n, 2n, 3n, 4n])).not.toThrow();
  });

  it("creates an attachment for more than 4 values", () => {
    expect(createNoteAttachment([1n, 2n, 3n, 4n, 5n])).toBeDefined();
  });

  it("accepts number[] input", () => {
    expect(() => createNoteAttachment([1, 2, 3])).not.toThrow();
  });

  it("accepts Uint8Array input", () => {
    expect(() => createNoteAttachment(new Uint8Array([1, 2, 3]))).not.toThrow();
  });

  it("pads to a multiple of 4 without throwing", () => {
    expect(() => createNoteAttachment([1n, 2n, 3n, 4n, 5n])).not.toThrow();
    expect(() =>
      createNoteAttachment([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n])
    ).not.toThrow();
  });
});
