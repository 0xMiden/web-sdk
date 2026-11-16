import { describe, it, expect } from "vitest";
import { getNoteFilterType, getNoteType } from "../../utils/noteFilters";
import { NoteFilterTypes, NoteType } from "@miden-sdk/miden-sdk";

describe("getNoteFilterType", () => {
  it("should return All for undefined status", () => {
    expect(getNoteFilterType(undefined)).toBe(NoteFilterTypes.All);
  });

  it("should return All for 'all' status", () => {
    expect(getNoteFilterType("all")).toBe(NoteFilterTypes.All);
  });

  it("should return Consumed for 'consumed' status", () => {
    expect(getNoteFilterType("consumed")).toBe(NoteFilterTypes.Consumed);
  });

  it("should return Committed for 'committed' status", () => {
    expect(getNoteFilterType("committed")).toBe(NoteFilterTypes.Committed);
  });

  it("should return Expected for 'expected' status", () => {
    expect(getNoteFilterType("expected")).toBe(NoteFilterTypes.Expected);
  });

  it("should return Processing for 'processing' status", () => {
    expect(getNoteFilterType("processing")).toBe(NoteFilterTypes.Processing);
  });
});

describe("getNoteType", () => {
  it("returns NoteType.Private for 'private'", () => {
    expect(getNoteType("private")).toBe(NoteType.Private);
  });

  it("returns NoteType.Public for 'public'", () => {
    expect(getNoteType("public")).toBe(NoteType.Public);
  });

  it("falls back to NoteType.Private for an unknown runtime value", () => {
    // The TS type only allows "private" | "public", but runtime callers
    // (older third-party code) might pass other strings. Default branch.
    expect(getNoteType("encrypted" as unknown as "private" | "public")).toBe(
      NoteType.Private
    );
  });
});
