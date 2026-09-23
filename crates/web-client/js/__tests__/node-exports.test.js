import { describe, expect, it, vi } from "vitest";

// These exports are JS polyfills and must work independently of native exports.
vi.mock("../node/loader.js", () => ({ loadNativeModule: () => ({}) }));

import {
  AccountArray,
  AccountIdArray,
  AccountInputsArray,
  FeltArray,
  ForeignAccountArray,
  NoteAndArgsArray,
  NoteArray,
  NoteDetailsAndTagArray,
  NoteIdAndArgsArray,
  NoteRecipientArray,
  OutputNoteArray,
  StorageSlotArray,
  TransactionScriptInputPairArray,
} from "../node-index.js";

describe("Node array exports", () => {
  it.each([
    ["AccountArray", AccountArray],
    ["AccountIdArray", AccountIdArray],
    ["AccountInputsArray", AccountInputsArray],
    ["FeltArray", FeltArray],
    ["ForeignAccountArray", ForeignAccountArray],
    ["NoteAndArgsArray", NoteAndArgsArray],
    ["NoteArray", NoteArray],
    ["NoteDetailsAndTagArray", NoteDetailsAndTagArray],
    ["NoteIdAndArgsArray", NoteIdAndArgsArray],
    ["NoteRecipientArray", NoteRecipientArray],
    ["OutputNoteArray", OutputNoteArray],
    ["StorageSlotArray", StorageSlotArray],
    ["TransactionScriptInputPairArray", TransactionScriptInputPairArray],
  ])("exports a usable %s constructor", (_name, ArrayType) => {
    expect(ArrayType).toBeTypeOf("function");
    expect(new ArrayType()).toHaveLength(0);
    expect(new ArrayType([])).toHaveLength(0);
    const item = {};
    const items = new ArrayType([item]);

    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0]).toBe(item);
    expect(items.get(0)).toBe(item);
  });
});
