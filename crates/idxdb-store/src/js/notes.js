import { getDatabase } from "./schema.js";
import { logWebStoreError, uint8ArrayToBase64 } from "./utils.js";
export async function getOutputNotes(dbId, states) {
    try {
        const db = getDatabase(dbId);
        let notes = states.length == 0
            ? await db.outputNotes.toArray()
            : await db.outputNotes
                .where("stateDiscriminant")
                .anyOf(states)
                .toArray();
        return await processOutputNotes(notes);
    }
    catch (err) {
        logWebStoreError(err, "Failed to get output notes");
    }
}
export async function getInputNotes(dbId, states) {
    try {
        const db = getDatabase(dbId);
        let notes;
        if (states.length === 0) {
            notes = await db.inputNotes.toArray();
        }
        else {
            notes = await db.inputNotes
                .where("stateDiscriminant")
                .anyOf(states)
                .toArray();
        }
        return await processInputNotes(dbId, notes);
    }
    catch (err) {
        logWebStoreError(err, "Failed to get input notes");
    }
}
export async function getInputNotesFromIds(dbId, noteIds) {
    try {
        const db = getDatabase(dbId);
        let notes = await db.inputNotes.where("noteId").anyOf(noteIds).toArray();
        return await processInputNotes(dbId, notes);
    }
    catch (err) {
        logWebStoreError(err, "Failed to get input notes from IDs");
    }
}
export async function getInputNotesFromNullifiers(dbId, nullifiers) {
    try {
        const db = getDatabase(dbId);
        let notes = await db.inputNotes
            .where("nullifier")
            .anyOf(nullifiers)
            .toArray();
        return await processInputNotes(dbId, notes);
    }
    catch (err) {
        logWebStoreError(err, "Failed to get input notes from nullifiers");
    }
}
export async function getOutputNotesFromNullifiers(dbId, nullifiers) {
    try {
        const db = getDatabase(dbId);
        let notes = await db.outputNotes
            .where("nullifier")
            .anyOf(nullifiers)
            .toArray();
        return await processOutputNotes(notes);
    }
    catch (err) {
        logWebStoreError(err, "Failed to get output notes from nullifiers");
    }
}
export async function getInputNotesFromDetailsCommitments(dbId, detailsCommitments) {
    try {
        const db = getDatabase(dbId);
        let notes = await db.inputNotes
            .where("detailsCommitment")
            .anyOf(detailsCommitments)
            .toArray();
        return await processInputNotes(dbId, notes);
    }
    catch (err) {
        logWebStoreError(err, "Failed to get input notes from details commitments");
    }
}
export async function getInputNotesFromScriptRoots(dbId, scriptRoots) {
    try {
        const db = getDatabase(dbId);
        let notes = await db.inputNotes
            .where("scriptRoot")
            .anyOf(scriptRoots)
            .toArray();
        return await processInputNotes(dbId, notes);
    }
    catch (err) {
        logWebStoreError(err, "Failed to get input notes from script roots");
    }
}
export async function getOutputNotesFromDetailsCommitments(dbId, detailsCommitments) {
    try {
        const db = getDatabase(dbId);
        let notes = await db.outputNotes
            .where("detailsCommitment")
            .anyOf(detailsCommitments)
            .toArray();
        return await processOutputNotes(notes);
    }
    catch (err) {
        logWebStoreError(err, "Failed to get output notes from details commitments");
    }
}
export async function getOutputNotesFromIds(dbId, noteIds) {
    try {
        const db = getDatabase(dbId);
        let notes = await db.outputNotes.where("noteId").anyOf(noteIds).toArray();
        return await processOutputNotes(notes);
    }
    catch (err) {
        logWebStoreError(err, "Failed to get output notes from IDs");
    }
}
export async function getUnspentInputNoteNullifiers(dbId) {
    try {
        const db = getDatabase(dbId);
        const notes = await db.inputNotes
            .where("stateDiscriminant")
            .anyOf([2, 4, 5])
            .toArray();
        return notes
            .map((note) => note.nullifier)
            .filter((nullifier) => nullifier != null);
    }
    catch (err) {
        logWebStoreError(err, "Failed to get unspent input note nullifiers");
    }
}
export async function getNoteScript(dbId, scriptRoot) {
    try {
        const db = getDatabase(dbId);
        const noteScript = await db.notesScripts
            .where("scriptRoot")
            .equals(scriptRoot)
            .first();
        return noteScript;
    }
    catch (err) {
        logWebStoreError(err, "Failed to get note script from root");
    }
}
export async function upsertInputNote(dbId, detailsCommitment, noteId, assets, attachments, serialNumber, inputs, scriptRoot, serializedNoteScript, nullifier, serializedCreatedAt, stateDiscriminant, state, consumedBlockHeight, consumedTxOrder, consumerAccountId, tx) {
    const db = getDatabase(dbId);
    const doWork = async (t) => {
        try {
            const data = {
                detailsCommitment,
                // noteId/nullifier are only known once the note's metadata is available.
                noteId: noteId ?? undefined,
                assets,
                attachments,
                serialNumber,
                inputs,
                scriptRoot,
                nullifier: nullifier ?? undefined,
                state,
                stateDiscriminant,
                serializedCreatedAt,
                // These fields are null for non-consumed notes.
                // Convert null -> undefined so Dexie omits them from compound indexes.
                consumedBlockHeight: consumedBlockHeight ?? undefined,
                consumedTxOrder: consumedTxOrder ?? undefined,
                consumerAccountId: consumerAccountId ?? undefined,
            };
            await t.inputNotes.put(data);
            const noteScriptData = {
                scriptRoot,
                serializedNoteScript,
            };
            await t.notesScripts.put(noteScriptData);
            /* v8 ignore next 3 — requires a mid-transaction Dexie write failure, not modelable with fake-indexeddb */
        }
        catch (error) {
            logWebStoreError(error, `Error inserting note: ${detailsCommitment}`);
            throw error;
        }
    };
    if (tx)
        return doWork(tx);
    return db.dexie.transaction("rw", db.inputNotes, db.notesScripts, doWork);
}
const INPUT_NOTE_CONSUMPTION_INDEX = "[consumedBlockHeight+consumedTxOrder+detailsCommitment]";
// Seeks the consumption index past the cursor and returns the first row passing the filters, as
// a one-element array so the caller keeps a uniform shape. The cursor is compared as an index
// key rather than looked up, so it resolves the right position even after its own note is gone.
// Rows missing a consumption field are absent from the compound index, which is the ordering
// contract's "not consumed yet, not in the sequence".
export async function getInputNoteAfter(dbId, states, consumerAccountId, blockStart, blockEnd, cursorBlockHeight, cursorTxOrder, cursorDetailsCommitment) {
    try {
        const db = getDatabase(dbId);
        const hasCursor = cursorBlockHeight != null &&
            cursorTxOrder != null &&
            cursorDetailsCommitment != null;
        // `blockStart` only narrows the seek when no cursor is given; with one it stays in the
        // predicate below, since a cursor past `blockStart` is the tighter bound and a cursor
        // before it excludes nothing that the predicate does not.
        const ordered = hasCursor
            ? db.inputNotes
                .where(INPUT_NOTE_CONSUMPTION_INDEX)
                .above([cursorBlockHeight, cursorTxOrder, cursorDetailsCommitment])
            : blockStart != null
                ? db.inputNotes
                    .where(INPUT_NOTE_CONSUMPTION_INDEX)
                    .aboveOrEqual([blockStart])
                : db.inputNotes.orderBy(INPUT_NOTE_CONSUMPTION_INDEX);
        const note = await ordered
            .filter((n) => {
            if (states.length > 0 && !states.includes(n.stateDiscriminant))
                return false;
            if (n.consumerAccountId !== consumerAccountId)
                return false;
            if (blockStart != null && n.consumedBlockHeight < blockStart)
                return false;
            if (blockEnd != null && n.consumedBlockHeight > blockEnd)
                return false;
            return true;
        })
            .first();
        if (note == null)
            return [];
        return await processInputNotes(dbId, [note]);
    }
    catch (err) {
        logWebStoreError(err, "Failed to get input note after cursor");
    }
}
export async function upsertOutputNote(dbId, detailsCommitment, noteId, assets, attachments, recipientDigest, metadata, nullifier, expectedHeight, stateDiscriminant, state, tx) {
    const db = getDatabase(dbId);
    const doWork = async (t) => {
        try {
            const data = {
                detailsCommitment,
                noteId,
                assets,
                attachments,
                recipientDigest,
                metadata,
                nullifier: nullifier ? nullifier : undefined,
                expectedHeight,
                stateDiscriminant,
                state,
            };
            await t.outputNotes.put(data);
            /* v8 ignore next 3 — requires a mid-transaction Dexie write failure, not modelable with fake-indexeddb */
        }
        catch (error) {
            logWebStoreError(error, `Error inserting note: ${detailsCommitment}`);
            throw error;
        }
    };
    if (tx)
        return doWork(tx);
    return db.dexie.transaction("rw", db.outputNotes, db.notesScripts, doWork);
}
async function processInputNotes(dbId, notes) {
    const db = getDatabase(dbId);
    return await Promise.all(notes.map(async (note) => {
        const assetsBase64 = uint8ArrayToBase64(note.assets);
        const serialNumberBase64 = uint8ArrayToBase64(note.serialNumber);
        const inputsBase64 = uint8ArrayToBase64(note.inputs);
        let serializedNoteScriptBase64 = undefined;
        if (note.scriptRoot) {
            let record = await db.notesScripts.get(note.scriptRoot);
            if (record) {
                serializedNoteScriptBase64 = uint8ArrayToBase64(record.serializedNoteScript);
            }
        }
        const stateBase64 = uint8ArrayToBase64(note.state);
        const attachmentsBase64 = uint8ArrayToBase64(note.attachments);
        return {
            assets: assetsBase64,
            serialNumber: serialNumberBase64,
            inputs: inputsBase64,
            createdAt: note.serializedCreatedAt,
            serializedNoteScript: serializedNoteScriptBase64,
            state: stateBase64,
            attachments: attachmentsBase64,
        };
    }));
}
async function processOutputNotes(notes) {
    return await Promise.all(notes.map((note) => {
        const assetsBase64 = uint8ArrayToBase64(note.assets);
        const metadataBase64 = uint8ArrayToBase64(note.metadata);
        const stateBase64 = uint8ArrayToBase64(note.state);
        const attachmentsBase64 = uint8ArrayToBase64(note.attachments);
        return {
            assets: assetsBase64,
            recipientDigest: note.recipientDigest,
            metadata: metadataBase64,
            expectedHeight: note.expectedHeight,
            state: stateBase64,
            attachments: attachmentsBase64,
        };
    }));
}
export async function upsertNoteScript(dbId, scriptRoot, serializedNoteScript) {
    const db = getDatabase(dbId);
    return db.dexie.transaction("rw", db.outputNotes, db.notesScripts, async (tx) => {
        try {
            const noteScriptData = {
                scriptRoot,
                serializedNoteScript,
            };
            await tx.notesScripts.put(noteScriptData);
            /* v8 ignore next 3 — requires a mid-transaction Dexie write failure, not modelable with fake-indexeddb */
        }
        catch (error) {
            logWebStoreError(error, `Error inserting note script: ${scriptRoot}`);
        }
    });
}
