import {
  resolveAccountRef,
  resolveAddress,
  resolveNoteIdHex,
} from "../utils.js";

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

  // Notes consumable RIGHT NOW by `account`, as `InputNoteRecord[]`.
  //
  // `getConsumableNotes()` also returns block-locked notes (status
  // `consumableAfter`), which are not usable yet — so an API named "available"
  // must exclude them, otherwise a caller acts on a note the chain will reject.
  // A record is consumable-now when its consumability has no
  // `consumableAfterBlock`.
  //
  // LOAD-BEARING UPSTREAM CONTRACT: JS `NoteConsumptionStatus` exposes only
  // `consumableAfterBlock()`, so it cannot distinguish `Consumable` /
  // `ConsumableWithAuthorization` (now) from `NeverConsumable` /
  // `UnconsumableConditions` — all four return `null`. This filter is correct
  // ONLY because miden-client's `NoteScreener::is_relevant` already strips the
  // never-consumable variants before `getConsumableNotes` returns, so every
  // record here is `Consumable` | `ConsumableWithAuthorization` | `ConsumableAfter`
  // and `null` unambiguously means now. If a future miden-client surfaces a
  // non-consumable status through `getConsumableNotes`, revisit this (and prefer
  // exposing a real status discriminant on `NoteConsumptionStatus`).
  //
  // Callers that need the block-locked notes, or the full per-account
  // consumability metadata, use `listConsumable()`.
  async listAvailable(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const accountId = resolveAccountRef(opts.account, wasm);
    const consumable = await this.#inner.getConsumableNotes(accountId);
    return consumable
      .filter((c) =>
        c
          .noteConsumability()
          .some((nc) => nc.consumptionStatus().consumableAfterBlock() == null)
      )
      .map((c) => c.inputNoteRecord());
  }

  // Full consumability view: every note `getConsumableNotes()` returns —
  // consumable-now AND block-locked — as `ConsumableNoteRecord[]` with
  // `noteConsumability()` metadata intact (the status `consumableAfterBlock`).
  // Unlike `listAvailable` (which keeps only consumable-now and maps each to an
  // `inputNoteRecord()`), this preserves the metadata so callers can tell now
  // from `consumableAfterBlock`, and which account each status belongs to.
  // Omit `account` (or pass null) to list notes consumable by any tracked
  // account — matching the underlying `getConsumableNotes(account?)`.
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

  async fetchPrivate(opts) {
    this.#client.assertNotTerminated();
    if (opts?.mode === "all") {
      await this.#inner.fetchAllPrivateNotes();
    } else {
      await this.#inner.fetchPrivateNotes();
    }
  }

  async sendPrivate(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();

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
    await this.#inner.sendPrivateNote(note, address);
  }
}

function buildNoteFilter(query, wasm) {
  if (!query) {
    return new wasm.NoteFilter(wasm.NoteFilterTypes.All, undefined);
  }

  if (query.ids) {
    const noteIds = query.ids.map((id) =>
      wasm.NoteId.fromHex(resolveNoteIdHex(id))
    );
    return new wasm.NoteFilter(wasm.NoteFilterTypes.List, noteIds);
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
