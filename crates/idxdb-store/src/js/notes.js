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
        return await processOutputNotes(dbId, notes);
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
        return await processOutputNotes(dbId, notes);
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
        return await processOutputNotes(dbId, notes);
    }
    catch (err) {
        logWebStoreError(err, "Failed to get output notes from details commitments");
    }
}
export async function getOutputNotesFromIds(dbId, noteIds) {
    try {
        const db = getDatabase(dbId);
        let notes = await db.outputNotes.where("noteId").anyOf(noteIds).toArray();
        return await processOutputNotes(dbId, notes);
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
// Returns a one-element array so the caller's shape is uniform with the other readers. The
// cursor is compared as an index key rather than looked up, so it still resolves the right
// position once its own note is deleted.
export async function getInputNoteAfter(dbId, states, consumerAccountId, blockStart, blockEnd, cursorBlockHeight, cursorTxOrder, cursorDetailsCommitment) {
    try {
        const db = getDatabase(dbId);
        const hasCursor = cursorBlockHeight != null &&
            cursorTxOrder != null &&
            cursorDetailsCommitment != null;
        // With a cursor, `blockStart` is left to the predicate below: the cursor is the tighter
        // lower bound, and emitting both abandons the row-value seek.
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
export async function upsertOutputNote(dbId, detailsCommitment, noteId, assets, attachments, recipientDigest, metadata, nullifier, expectedHeight, stateDiscriminant, state, scriptRoot, serializedNoteScript, tx) {
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
                // Only known once the recipient is known.
                scriptRoot: scriptRoot ?? undefined,
                stateDiscriminant,
                state,
            };
            await t.outputNotes.put(data);
            if (scriptRoot && serializedNoteScript) {
                await t.notesScripts.put({ scriptRoot, serializedNoteScript });
            }
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
    const scripts = await getNoteScriptsBase64(dbId, notes.map((note) => note.scriptRoot));
    return notes.map((note) => {
        const assetsBase64 = uint8ArrayToBase64(note.assets);
        const serialNumberBase64 = uint8ArrayToBase64(note.serialNumber);
        const inputsBase64 = uint8ArrayToBase64(note.inputs);
        const stateBase64 = uint8ArrayToBase64(note.state);
        const attachmentsBase64 = uint8ArrayToBase64(note.attachments);
        return {
            assets: assetsBase64,
            serialNumber: serialNumberBase64,
            inputs: inputsBase64,
            createdAt: note.serializedCreatedAt,
            serializedNoteScript: scripts.get(note.scriptRoot),
            state: stateBase64,
            attachments: attachmentsBase64,
        };
    });
}
async function processOutputNotes(dbId, notes) {
    const scripts = await getNoteScriptsBase64(dbId, notes.map((note) => note.scriptRoot));
    return notes.map((note) => {
        const assetsBase64 = uint8ArrayToBase64(note.assets);
        const metadataBase64 = uint8ArrayToBase64(note.metadata);
        const serializedNoteScriptBase64 = note.scriptRoot
            ? scripts.get(note.scriptRoot)
            : undefined;
        const stateBase64 = uint8ArrayToBase64(note.state);
        const attachmentsBase64 = uint8ArrayToBase64(note.attachments);
        return {
            assets: assetsBase64,
            recipientDigest: note.recipientDigest,
            metadata: metadataBase64,
            expectedHeight: note.expectedHeight,
            serializedNoteScript: serializedNoteScriptBase64,
            state: stateBase64,
            attachments: attachmentsBase64,
        };
    });
}
// Fetches the scripts for the given roots in one read and returns them base64-encoded, keyed by
// root. Empty roots are skipped, and roots without a stored script are absent from the map.
async function getNoteScriptsBase64(dbId, roots) {
    const db = getDatabase(dbId);
    const uniqueRoots = [...new Set(roots.filter((root) => !!root))];
    const records = await db.notesScripts.bulkGet(uniqueRoots);
    return new Map(records
        .filter((record) => record !== undefined)
        .map((record) => [
        record.scriptRoot,
        uint8ArrayToBase64(record.serializedNoteScript),
    ]));
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
