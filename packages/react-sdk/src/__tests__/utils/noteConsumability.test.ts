import { describe, it, expect } from "vitest";
import { getNoteConsumabilityStatus } from "../../utils/noteConsumability";
import { createMockNoteConsumability as entry } from "../mocks/miden-sdk";

describe("getNoteConsumabilityStatus", () => {
  it("reads an empty result as never consumable", () => {
    expect(getNoteConsumabilityStatus([])).toEqual({ kind: "never" });
  });

  it("reports immediately when any entry is consumable now", () => {
    expect(
      getNoteConsumabilityStatus([entry("0xa", false, 50), entry("0xb", true)])
    ).toEqual({ kind: "immediately" });
  });

  it("reports the earliest unlock height of locked entries", () => {
    expect(
      getNoteConsumabilityStatus([
        entry("0xa", false, 90),
        entry("0xb", false, 40),
      ])
    ).toEqual({ kind: "afterBlock", blockHeight: 40 });
  });

  it("reads an entry with neither status as never consumable", () => {
    expect(getNoteConsumabilityStatus([entry("0xa", false)])).toEqual({
      kind: "never",
    });
  });

  it("counts only the given account's entries", () => {
    const entries = [entry("0xa", true), entry("0xb", false, 70)];
    expect(getNoteConsumabilityStatus(entries, "0xb")).toEqual({
      kind: "afterBlock",
      blockHeight: 70,
    });
    expect(getNoteConsumabilityStatus(entries, "0xc")).toEqual({
      kind: "never",
    });
  });
});
