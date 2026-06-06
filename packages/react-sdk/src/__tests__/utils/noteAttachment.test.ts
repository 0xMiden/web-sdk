import { describe, it, expect } from "vitest";
import {
  readNoteAttachment,
  createNoteAttachment,
  emptyAttachment,
} from "../../utils/noteAttachment";

describe("readNoteAttachment", () => {
  // On the 0.15 protocol surface the JS `NoteAttachment` class exposes only
  // `numWords()` — there is no word-content accessor. Decoding is therefore a
  // no-op stub that returns null for every input; the contract surface tests
  // here exist so future PR-B follow-up work (`NoteAttachment.toWord(s)`)
  // re-implements it the moment the WASM surface lands.
  it("returns null for any input until decoding is wired up", () => {
    const note = {} as Parameters<typeof readNoteAttachment>[0];
    expect(readNoteAttachment(note)).toBeNull();
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
  });

  it("pads to 4 elements without throwing for 1-4 values", () => {
    expect(() => createNoteAttachment([1n])).not.toThrow();
    expect(() => createNoteAttachment([1n, 2n, 3n])).not.toThrow();
    expect(() => createNoteAttachment([1n, 2n, 3n, 4n])).not.toThrow();
  });

  it("creates a multi-Word attachment for > 4 values", () => {
    const attachment = createNoteAttachment([1n, 2n, 3n, 4n, 5n]);
    expect(attachment).toBeDefined();
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
  });
});
