import Dexie from "dexie";
// Helper for undefined values, like map for Option<T> in Rust.
// A better name for this is welcome.
export const mapOption = (value, func) => {
    return value != undefined ? func(value) : undefined;
};
// Anything can be thrown as an error in raw JS (also the TS compiler can't type-check exceptions),
// so we allow it here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const logWebStoreError = (error, errorContext) => {
    if (error instanceof Dexie.DexieError) {
        if (errorContext) {
            console.error(`${errorContext}: Indexdb error (${error.name}): ${error.message}`);
        }
        else {
            console.error(`Indexdb error: (${error.name}): ${error.message}`);
        }
        mapOption(error.stack, (stack) => {
            console.error(`Stacktrace: \n ${stack}`);
        });
        mapOption(error.inner, (innerException) => logWebStoreError(innerException));
    }
    else if (error instanceof Error) {
        console.error(`Unexpected error while accessing indexdb: ${error.toString()}`);
        mapOption(error.stack, (stack) => {
            console.error(`Stacktrace: ${stack}`);
        });
    }
    else {
        console.error(`Got an exception with a non-error value, as JSON: \n ${JSON.stringify(error)}. As String \n ${String(error)} `);
        console.trace();
    }
    throw error;
};
// Partial blockchain (MMR) authentication nodes are part of the local
// `PartialMmr` state. Once a node index is known its value is fixed, so a
// later write with the same index but a different value indicates a buggy or
// malicious sync path. Insert nodes that are missing, accept writes that match
// the stored value, and reject conflicting writes so the known-good value is
// never silently overwritten.
export const putPartialBlockchainNodesNoOverwrite = async (table, data) => {
    const existing = await table.bulkGet(data.map((entry) => entry.id));
    const toAdd = [];
    for (let i = 0; i < data.length; i++) {
        const current = existing[i];
        if (current === undefined) {
            toAdd.push(data[i]);
        }
        else if (current.node !== data[i].node) {
            throw new Error(`Refusing to overwrite partial blockchain node ${data[i].id}: ` +
                `stored value differs from the new value`);
        }
        // current.node === data[i].node: already stored, nothing to do.
    }
    if (toAdd.length > 0) {
        await table.bulkAdd(toAdd);
    }
};
export const uint8ArrayToBase64 = (bytes) => {
    const binary = bytes.reduce((acc, byte) => acc + String.fromCharCode(byte), "");
    return btoa(binary);
};
