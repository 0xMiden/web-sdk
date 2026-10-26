import {
  isConsumableNow,
  resolveAccountRef,
  resolveAddress,
  resolveNoteIdHex,
} from "../utils.js";

const PAGE_STATES = new Map([
  ["expected", [0]],
  ["unverified", [1]],
  ["committed", [2]],
  ["processing", [4, 5]],
  ["consumed", [6, 7, 8]],
]);

export class NotesResource {
  #inner;
  #getWasm;
  #client;

  constructor(inner, getWasm, client) {
    this.#inner = inner;
    this.#getWasm = getWasm;
    this.#client = client;
  }

  async list(query) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const filter = buildNoteFilter(query, wasm);
    return await this.#inner.getInputNotes(filter);
  }

  /**
   * Scan at most limit raw input-note rows before selecting states. The cursor
   * advances over unselected rows, so an empty result need not be exhausted.
   * Uses the serialized main store even with useWorker:true; native Node rejects.
   * @param {import("../types/api-types").InputNotePageQuery} [query]
   * @returns {Promise<import("../types/api-types").InputNotePage>}
   */
  async listPage(query = {}) {
    this.#client.assertNotTerminated();
    if (!query || typeof query !== "object" || Array.isArray(query)) {
      throw new Error("Input note page query must be an object");
    }
    const { states, afterDetailsCommitment, limit = 128 } = query;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new Error(
        "Input note page limit must be an integer between 1 and 256"
      );
    }
    const selected = new Set();
    if (states !== undefined) {
      if (!Array.isArray(states) || states.length === 0) {
        throw new Error("Input note page states must be a nonempty array");
      }
      for (const state of states) {
        const values = PAGE_STATES.get(state);
        if (!values) throw new Error("Unknown input note page state");
        for (const value of values) selected.add(value);
      }
    }
    if (
      afterDetailsCommitment != null &&
      (typeof afterDetailsCommitment !== "string" ||
        !/^0x[0-9a-f]{64}$/.test(afterDetailsCommitment))
    ) {
      throw new Error(
        "Input note page cursor must be a canonical details commitment"
      );
    }
    const result = await this.#inner.getInputNotesPage(
      new Uint8Array([...selected]),
      afterDetailsCommitment ?? undefined,
      limit
    );
    try {
      return {
        notes: result.notes(),
        nextCursor: result.nextCursor() ?? null,
        exhausted: result.exhausted(),
      };
    } finally {
      result.free?.();
    }
  }

  async get(noteId) {
    this.#client.assertNotTerminated();
    const result = await this.#inner.getInputNote(resolveNoteIdHex(noteId));
    return result ?? null;
  }

  async listSent(query) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const filter = buildNoteFilter(query, wasm);
    return await this.#inner.getOutputNotes(filter);
  }

  // Drops block-locked notes; `listConsumable` returns them.
  async listAvailable(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const accountId = resolveAccountRef(opts.account, wasm);
    // getConsumableNotes takes AccountId by value, so read the hex first.
    const accountIdHex = accountId.toString();
    const consumable = await this.#inner.getConsumableNotes(accountId);
    return consumable
      .filter((c) => isConsumableNow(c, accountIdHex))
      .map((c) => c.inputNoteRecord());
  }

  async listConsumable(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const accountId =
      opts?.account == null ? undefined : resolveAccountRef(opts.account, wasm);
    return await this.#inner.getConsumableNotes(accountId);
  }

  async import(noteFile) {
    this.#client.assertNotTerminated();
    return await this.#inner.importNoteFile(noteFile);
  }

  async export(noteId, opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const format = opts?.format ?? wasm.NoteExportFormat.Full;
    return await this.#inner.exportNoteFile(resolveNoteIdHex(noteId), format);
  }

  async fetchPrivate() {
    this.#client.assertNotTerminated();
    await this.#inner.fetchPrivateNotes();
  }

  async sendPrivate(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();

    if (!opts?.inclusionProof) {
      throw new Error(
        "sendPrivate requires inclusionProof: a NoteInclusionProof the transport verifies. " +
          "The recipient scans from the block the proof names. " +
          "For one of this client's own output notes, use sendPrivateOutput({ noteId, to }), " +
          "which reads the proof sync stored on the note."
      );
    }

    let note;
    const input = opts.note;
    // Check if input is a Note object (has .id() and .assets() but not .toNote())
    if (
      input &&
      typeof input === "object" &&
      typeof input.id === "function" &&
      typeof input.assets === "function" &&
      typeof input.toNote !== "function"
    ) {
      note = input;
    } else {
      const noteHex = resolveNoteIdHex(input);
      const noteRecord = await this.#inner.getInputNote(noteHex);
      if (!noteRecord) {
        throw new Error(`Note not found: ${noteHex}`);
      }
      note = noteRecord.toNote();
    }

    const address = resolveAddress(opts.to, wasm);
    await this.#inner.sendPrivateNote(note, address, opts.inclusionProof);
  }

  async sendPrivateOutput(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const noteHex = resolveNoteIdHex(opts.noteId);
    const address = resolveAddress(opts.to, wasm);
    await this.#inner.sendPrivateOutputNote(noteHex, address);
  }
}

function buildNoteFilter(query, wasm) {
  if (!query) {
    return new wasm.NoteFilter(wasm.NoteFilterTypes.All, undefined);
  }

  if (query.detailsCommitments !== undefined) {
    if (
      query.status !== undefined ||
      query.ids !== undefined ||
      query.scriptRoots !== undefined
    ) {
      throw new Error(
        "detailsCommitments and other note filters are mutually exclusive"
      );
    }
    if (!Array.isArray(query.detailsCommitments)) {
      throw new Error("detailsCommitments must be an array");
    }
    const commitments = query.detailsCommitments.map((value) =>
      typeof value === "string" ? wasm.Word.fromHex(value) : value
    );
    return new wasm.NoteFilter(
      wasm.NoteFilterTypes.DetailsCommitments,
      undefined,
      undefined,
      commitments
    );
  }

  if (query.ids) {
    const noteIds = query.ids.map((id) =>
      wasm.NoteId.fromHex(resolveNoteIdHex(id))
    );
    return new wasm.NoteFilter(wasm.NoteFilterTypes.List, noteIds);
  }

  if (query.scriptRoots) {
    const scriptRoots = query.scriptRoots.map((root) =>
      typeof root === "string" ? wasm.Word.fromHex(root) : root
    );
    return new wasm.NoteFilter(
      wasm.NoteFilterTypes.ScriptRoots,
      undefined,
      scriptRoots
    );
  }

  if (query.status) {
    const statusMap = {
      consumed: wasm.NoteFilterTypes.Consumed,
      committed: wasm.NoteFilterTypes.Committed,
      expected: wasm.NoteFilterTypes.Expected,
      processing: wasm.NoteFilterTypes.Processing,
      unverified: wasm.NoteFilterTypes.Unverified,
    };
    const filterType = statusMap[query.status];
    if (filterType === undefined) {
      throw new Error(`Unknown note status: ${query.status}`);
    }
    return new wasm.NoteFilter(filterType, undefined);
  }

  return new wasm.NoteFilter(wasm.NoteFilterTypes.All, undefined);
}
