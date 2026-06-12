import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotesResource } from "../../resources/notes.js";

function makeWasm(overrides = {}) {
  const NoteFilterTypes = {
    All: "All",
    Consumed: "Consumed",
    Committed: "Committed",
    Expected: "Expected",
    Processing: "Processing",
    Unverified: "Unverified",
    List: "List",
  };
  const filterInstance = { type: "filter" };
  return {
    NoteFilter: vi.fn().mockReturnValue(filterInstance),
    NoteFilterTypes,
    NoteId: {
      fromHex: vi.fn((hex) => ({ hex })),
    },
    NoteExportFormat: { Full: "Full" },
    AccountId: {
      fromHex: vi.fn((hex) => ({ hex })),
      fromBech32: vi.fn((b) => ({ bech32: b })),
    },
    Address: {
      fromBech32: vi.fn((b) => ({ bech32: b })),
      fromAccountId: vi.fn((id, _) => ({ accountId: id })),
    },
    ...overrides,
  };
}

function makeInner() {
  return {
    getInputNotes: vi.fn(),
    getInputNote: vi.fn(),
    getOutputNotes: vi.fn(),
    getConsumableNotes: vi.fn(),
    importNoteFile: vi.fn(),
    exportNoteFile: vi.fn(),
    fetchAllPrivateNotes: vi.fn(),
    fetchPrivateNotes: vi.fn(),
    sendPrivateNote: vi.fn(),
  };
}

function makeClient() {
  return { assertNotTerminated: vi.fn() };
}

describe("NotesResource", () => {
  let inner;
  let client;
  let wasm;
  let getWasm;

  beforeEach(() => {
    inner = makeInner();
    client = makeClient();
    wasm = makeWasm();
    getWasm = vi.fn().mockResolvedValue(wasm);
  });

  function makeResource() {
    return new NotesResource(inner, getWasm, client);
  }

  describe("list", () => {
    it("returns notes with NoteFilterTypes.All when no query given", async () => {
      inner.getInputNotes.mockResolvedValue(["note1"]);
      const resource = makeResource();
      const result = await resource.list();
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(wasm.NoteFilter).toHaveBeenCalledWith("All", undefined);
      expect(result).toEqual(["note1"]);
    });

    it("filters by status: consumed", async () => {
      inner.getInputNotes.mockResolvedValue([]);
      const resource = makeResource();
      await resource.list({ status: "consumed" });
      expect(wasm.NoteFilter).toHaveBeenCalledWith("Consumed", undefined);
    });

    it("filters by status: committed", async () => {
      inner.getInputNotes.mockResolvedValue([]);
      const resource = makeResource();
      await resource.list({ status: "committed" });
      expect(wasm.NoteFilter).toHaveBeenCalledWith("Committed", undefined);
    });

    it("filters by status: expected", async () => {
      inner.getInputNotes.mockResolvedValue([]);
      const resource = makeResource();
      await resource.list({ status: "expected" });
      expect(wasm.NoteFilter).toHaveBeenCalledWith("Expected", undefined);
    });

    it("filters by status: processing", async () => {
      inner.getInputNotes.mockResolvedValue([]);
      const resource = makeResource();
      await resource.list({ status: "processing" });
      expect(wasm.NoteFilter).toHaveBeenCalledWith("Processing", undefined);
    });

    it("filters by status: unverified", async () => {
      inner.getInputNotes.mockResolvedValue([]);
      const resource = makeResource();
      await resource.list({ status: "unverified" });
      expect(wasm.NoteFilter).toHaveBeenCalledWith("Unverified", undefined);
    });

    it("throws on unknown status", async () => {
      const resource = makeResource();
      await expect(resource.list({ status: "bogus" })).rejects.toThrow(
        "Unknown note status: bogus"
      );
    });

    it("builds NoteFilter with ids array when query.ids provided", async () => {
      inner.getInputNotes.mockResolvedValue([]);
      const resource = makeResource();
      await resource.list({ ids: ["0xabc", "0xdef"] });
      expect(wasm.NoteId.fromHex).toHaveBeenCalledTimes(2);
      expect(wasm.NoteFilter).toHaveBeenCalledWith("List", expect.any(Array));
    });

    it("falls back to All when empty query object", async () => {
      inner.getInputNotes.mockResolvedValue([]);
      const resource = makeResource();
      await resource.list({});
      expect(wasm.NoteFilter).toHaveBeenCalledWith("All", undefined);
    });
  });

  describe("get", () => {
    it("returns the note when found", async () => {
      inner.getInputNote.mockResolvedValue({ id: () => "id1" });
      const resource = makeResource();
      const result = await resource.get("0xnote1");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(result).toEqual({ id: expect.any(Function) });
    });

    it("returns null when note not found", async () => {
      inner.getInputNote.mockResolvedValue(undefined);
      const resource = makeResource();
      const result = await resource.get("0xmissing");
      expect(result).toBeNull();
    });

    it("resolves string noteId directly", async () => {
      inner.getInputNote.mockResolvedValue(null);
      const resource = makeResource();
      await resource.get("0xabc123");
      expect(inner.getInputNote).toHaveBeenCalledWith("0xabc123");
    });
  });

  describe("listSent", () => {
    it("returns output notes with NoteFilterTypes.All when no query", async () => {
      inner.getOutputNotes.mockResolvedValue(["outNote1"]);
      const resource = makeResource();
      const result = await resource.listSent();
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(wasm.NoteFilter).toHaveBeenCalledWith("All", undefined);
      expect(result).toEqual(["outNote1"]);
    });

    it("filters sent notes by status", async () => {
      inner.getOutputNotes.mockResolvedValue([]);
      const resource = makeResource();
      await resource.listSent({ status: "consumed" });
      expect(wasm.NoteFilter).toHaveBeenCalledWith("Consumed", undefined);
    });
  });

  describe("listAvailable", () => {
    it("resolves account and returns inputNoteRecord for each consumable", async () => {
      const mockNote = { inputNoteRecord: vi.fn().mockReturnValue("record1") };
      inner.getConsumableNotes.mockResolvedValue([mockNote]);
      const resource = makeResource();
      const result = await resource.listAvailable({
        account: "0xaccountHex",
      });
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(result).toEqual(["record1"]);
    });

    it("resolves bech32 account ref", async () => {
      inner.getConsumableNotes.mockResolvedValue([]);
      const resource = makeResource();
      await resource.listAvailable({ account: "mBech32Account" });
      expect(wasm.AccountId.fromBech32).toHaveBeenCalledWith("mBech32Account");
    });

    it("returns empty array when no consumable notes", async () => {
      inner.getConsumableNotes.mockResolvedValue([]);
      const resource = makeResource();
      const result = await resource.listAvailable({ account: "0xacc" });
      expect(result).toEqual([]);
    });
  });

  describe("import", () => {
    it("delegates to inner.importNoteFile", async () => {
      inner.importNoteFile.mockResolvedValue("imported");
      const resource = makeResource();
      const result = await resource.import("noteFileData");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.importNoteFile).toHaveBeenCalledWith("noteFileData");
      expect(result).toBe("imported");
    });

    it("propagates rejection", async () => {
      inner.importNoteFile.mockRejectedValue(new Error("import error"));
      const resource = makeResource();
      await expect(resource.import("data")).rejects.toThrow("import error");
    });
  });

  describe("export", () => {
    it("uses Full format by default", async () => {
      inner.exportNoteFile.mockResolvedValue("exportedFile");
      const resource = makeResource();
      const result = await resource.export("0xnoteHex");
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.exportNoteFile).toHaveBeenCalledWith("0xnoteHex", "Full");
      expect(result).toBe("exportedFile");
    });

    it("uses provided format", async () => {
      inner.exportNoteFile.mockResolvedValue("exportedFile");
      const resource = makeResource();
      await resource.export("0xnoteHex", { format: "Custom" });
      expect(inner.exportNoteFile).toHaveBeenCalledWith("0xnoteHex", "Custom");
    });

    it("resolves NoteId object via toString/constructor.fromHex", async () => {
      inner.exportNoteFile.mockResolvedValue("exportedFile");
      const noteIdObj = {
        toString: vi.fn().mockReturnValue("0xnoteid"),
        constructor: { fromHex: vi.fn() },
      };
      const resource = makeResource();
      await resource.export(noteIdObj);
      expect(inner.exportNoteFile).toHaveBeenCalledWith("0xnoteid", "Full");
    });
  });

  describe("fetchPrivate", () => {
    it("calls fetchAllPrivateNotes when mode is 'all'", async () => {
      inner.fetchAllPrivateNotes.mockResolvedValue(undefined);
      const resource = makeResource();
      await resource.fetchPrivate({ mode: "all" });
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.fetchAllPrivateNotes).toHaveBeenCalledOnce();
      expect(inner.fetchPrivateNotes).not.toHaveBeenCalled();
    });

    it("calls fetchPrivateNotes by default (no opts)", async () => {
      inner.fetchPrivateNotes.mockResolvedValue(undefined);
      const resource = makeResource();
      await resource.fetchPrivate();
      expect(inner.fetchPrivateNotes).toHaveBeenCalledOnce();
      expect(inner.fetchAllPrivateNotes).not.toHaveBeenCalled();
    });

    it("calls fetchPrivateNotes when mode is not 'all'", async () => {
      inner.fetchPrivateNotes.mockResolvedValue(undefined);
      const resource = makeResource();
      await resource.fetchPrivate({ mode: "partial" });
      expect(inner.fetchPrivateNotes).toHaveBeenCalledOnce();
    });
  });

  describe("sendPrivate", () => {
    it("sends a Note object directly (has id() and assets(), no toNote())", async () => {
      inner.sendPrivateNote.mockResolvedValue(undefined);
      const noteObj = {
        id: vi.fn().mockReturnValue({ toString: () => "noteid" }),
        assets: vi.fn(),
      };
      const resource = makeResource();
      await resource.sendPrivate({ note: noteObj, to: "0xrecipient" });
      expect(client.assertNotTerminated).toHaveBeenCalledOnce();
      expect(inner.sendPrivateNote).toHaveBeenCalledWith(
        noteObj,
        expect.anything()
      );
    });

    it("fetches note by hex string and calls toNote() before sending", async () => {
      const note = { id: vi.fn(), assets: vi.fn(), toNote: vi.fn() };
      const record = {
        toNote: vi.fn().mockReturnValue(note),
      };
      inner.getInputNote.mockResolvedValue(record);
      inner.sendPrivateNote.mockResolvedValue(undefined);
      const resource = makeResource();
      await resource.sendPrivate({ note: "0xnoteHex", to: "0xrecipient" });
      expect(inner.getInputNote).toHaveBeenCalledWith("0xnoteHex");
      expect(record.toNote).toHaveBeenCalledOnce();
      expect(inner.sendPrivateNote).toHaveBeenCalledWith(
        note,
        expect.anything()
      );
    });

    it("throws when note not found by hex", async () => {
      inner.getInputNote.mockResolvedValue(undefined);
      const resource = makeResource();
      await expect(
        resource.sendPrivate({ note: "0xmissing", to: "0xrec" })
      ).rejects.toThrow("Note not found: 0xmissing");
    });

    it("resolves bech32 'to' address", async () => {
      inner.sendPrivateNote.mockResolvedValue(undefined);
      const noteObj = {
        id: vi.fn(),
        assets: vi.fn(),
      };
      const resource = makeResource();
      await resource.sendPrivate({
        note: noteObj,
        to: "mBech32Address",
      });
      expect(wasm.Address.fromBech32).toHaveBeenCalledWith("mBech32Address");
    });
  });
});
