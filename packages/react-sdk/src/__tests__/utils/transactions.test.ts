import { describe, it, expect } from "vitest";
import {
  extractFullNotes,
  extractFullNote,
  assertAnchorValueUsable,
  resolveTransactionRequest,
} from "../../utils/transactions";
import { NoteType } from "@miden-sdk/miden-sdk";

describe("extractFullNotes", () => {
  it("returns [] when the tx result has no executedTransaction", () => {
    expect(extractFullNotes({})).toEqual([]);
  });

  it("returns [] when accessor throws", () => {
    const txResult = {
      executedTransaction: () => {
        throw new Error("boom");
      },
    } as never;
    expect(extractFullNotes(txResult)).toEqual([]);
  });

  it("returns [] when there are no output notes", () => {
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({ notes: () => [] }),
      }),
    } as never;
    expect(extractFullNotes(txResult)).toEqual([]);
  });

  it("filters only Private notes that intoFull() can resolve", () => {
    const fullPrivate = { kind: "private-note" } as never;
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [
            // Public note — skipped.
            {
              noteType: () => NoteType.Public,
              intoFull: () => ({ kind: "public-note" }),
            },
            // Private note that intoFull resolves.
            {
              noteType: () => NoteType.Private,
              intoFull: () => fullPrivate,
            },
            // Private note where intoFull returns null (also skipped).
            {
              noteType: () => NoteType.Private,
              intoFull: () => null,
            },
          ],
        }),
      }),
    } as never;
    expect(extractFullNotes(txResult)).toEqual([fullPrivate]);
  });
});

describe("extractFullNote", () => {
  it("returns null when there are no notes", () => {
    const txResult = {
      executedTransaction: () => ({ outputNotes: () => ({ notes: () => [] }) }),
    } as never;
    expect(extractFullNote(txResult)).toBeNull();
  });

  it("returns null when the accessor throws", () => {
    const txResult = {
      executedTransaction: () => {
        throw new Error("boom");
      },
    } as never;
    expect(extractFullNote(txResult)).toBeNull();
  });

  it("returns the first note's intoFull() result", () => {
    const note = { kind: "first-note" } as never;
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [
            { intoFull: () => note },
            { intoFull: () => ({ kind: "second-note" }) },
          ],
        }),
      }),
    } as never;
    expect(extractFullNote(txResult)).toBe(note);
  });

  it("returns null when intoFull() returns null", () => {
    const txResult = {
      executedTransaction: () => ({
        outputNotes: () => ({ notes: () => [{ intoFull: () => null }] }),
      }),
    } as never;
    expect(extractFullNote(txResult)).toBeNull();
  });

  it("prefers userOutputNotes() so the kernel's fee note is never picked", () => {
    // On a fee-charging chain the unsplit list also holds the kernel's fee note, so index 0 of
    // it can be the fee note rather than the note being sent — and this note's id is what gets
    // relayed to the recipient.
    const userNote = { kind: "user-note" } as never;
    const feeNote = { kind: "fee-note" } as never;
    const txResult = {
      executedTransaction: () => ({
        userOutputNotes: () => [{ intoFull: () => userNote }],
        outputNotes: () => ({
          notes: () => [
            { intoFull: () => feeNote },
            { intoFull: () => userNote },
          ],
        }),
      }),
    } as never;
    expect(extractFullNote(txResult)).toBe(userNote);
  });
});

describe("assertAnchorValueUsable", () => {
  // Shared by useTransaction and usePreview, so testing it directly covers
  // both call sites. The web-client package has its own copy of this guard
  // with its own tests; the two are intentionally duplicated across packages.
  it.each([
    ["null", null],
    ["false", false],
    ["empty string", ""],
    ["zero", 0],
    ["bigint zero", 0n],
    ["NaN", NaN],
  ])("rejects %s", (_label, value) => {
    expect(() => assertAnchorValueUsable({ anchor: value })).toThrow(
      /await captureAnchor/
    );
  });

  it.each([
    ["an omitted anchor", {}],
    ["an explicitly undefined anchor", { anchor: undefined }],
    ["a present anchor", { anchor: { blockNum: () => 1 } }],
  ])("accepts %s", (_label, options) => {
    expect(() => assertAnchorValueUsable(options)).not.toThrow();
  });
});

describe("resolveTransactionRequest", () => {
  const client = {} as never;

  it("returns a directly supplied request", async () => {
    const request = { id: "req" } as never;
    await expect(resolveTransactionRequest(request, client)).resolves.toBe(
      request
    );
  });

  it("resolves a factory", async () => {
    const request = { id: "req" } as never;
    await expect(
      resolveTransactionRequest(() => Promise.resolve(request), client)
    ).resolves.toBe(request);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("rejects a %s request with a direct-value message", async (_l, value) => {
    await expect(
      resolveTransactionRequest(value as never, client)
    ).rejects.toThrow("a transaction request is required");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("rejects a factory resolving to %s", async (_label, value) => {
    await expect(
      resolveTransactionRequest(() => Promise.resolve(value) as never, client)
    ).rejects.toThrow("the transaction request factory returned");
  });
});
