export function validateIndexedDbOptions(options) {
    if (options === undefined)
        return {};
    if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new TypeError("indexedDb must be an options object");
    }
    const { durability, onFailure } = options;
    if (durability !== undefined &&
        !["default", "strict", "relaxed"].includes(durability)) {
        throw new TypeError("Invalid IndexedDB durability");
    }
    if (onFailure !== undefined && typeof onFailure !== "function") {
        throw new TypeError("IndexedDB onFailure must be a function");
    }
    return { durability, onFailure };
}
const kinds = {
    QuotaExceededError: "quota",
    UnknownError: "io",
    SecurityError: "unavailable",
    InvalidStateError: "unavailable",
    MissingAPIError: "unavailable",
    AbortError: "unexpected-abort",
};
let scopeCounter = 0;
export class StoragePolicy {
    storeName;
    durability;
    callbacks = new Map();
    scope = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${++scopeCounter}`;
    sequence = 0;
    constructor(storeName, options) {
        this.storeName = storeName;
        const validated = validateIndexedDbOptions(options);
        this.durability = validated.durability;
        this.subscribe("direct", validated.onFailure);
    }
    check(options) {
        if (options.durability !== undefined &&
            options.durability !== (this.durability ?? "default")) {
            throw new TypeError("Conflicting IndexedDB durability for shared store");
        }
    }
    subscribe(token, callback) {
        if (callback)
            this.callbacks.set(token, callback);
    }
    release(token) {
        this.callbacks.delete(token);
    }
    report(error, phase) {
        let cause = error;
        for (let depth = 0; cause && depth < 4; depth++) {
            if (cause.name === "AbortError" && cause.inner) {
                cause = cause.inner;
                continue;
            }
            const kind = cause.name && Object.hasOwn(kinds, cause.name) && kinds[cause.name];
            if (kind) {
                const failure = {
                    backend: "indexeddb",
                    storeName: this.storeName,
                    phase,
                    operation: `indexeddb.${phase}`,
                    kind,
                    errorName: cause.name,
                    eventId: `${this.scope}:${++this.sequence}`,
                };
                for (const callback of [...this.callbacks.values()]) {
                    try {
                        callback(Object.freeze({ ...failure }));
                    }
                    catch {
                        /* Consumer errors cannot replace storage errors. */
                    }
                }
                return true;
            }
            cause = cause.inner;
        }
        return false;
    }
    install(db) {
        const states = new WeakMap();
        const notify = (tx, error, phase) => {
            const state = states.get(tx);
            if (state?.reported)
                return;
            const native = state?.error;
            if (state?.intentional &&
                error?.name === "AbortError" &&
                native?.name !== "AbortError")
                return;
            const reported = this.report(native?.name === error?.name ? native : error, phase);
            if (state && reported)
                state.reported = true;
        };
        db.use({
            stack: "dbcore",
            name: "miden-storage-policy",
            create: (core) => ({
                ...core,
                table: (name) => {
                    const table = core.table(name);
                    const read = (tx, promise) => promise.catch((error) => {
                        notify(tx, error, "read");
                        throw error;
                    });
                    return {
                        ...table,
                        get: (req) => read(req.trans, table.get(req)),
                        getMany: (req) => read(req.trans, table.getMany(req)),
                        query: (req) => read(req.trans, table.query(req)),
                        count: (req) => read(req.trans, table.count(req)),
                        openCursor: (req) => read(req.trans, table.openCursor(req)).then((cursor) => {
                            if (cursor) {
                                const start = cursor.start;
                                cursor.start = function (callback) {
                                    return read(req.trans, start.call(this, callback));
                                };
                            }
                            return cursor;
                        }),
                        mutate: (req) => table.mutate(req).then((result) => {
                            if (result.numFailures) {
                                for (const error of Object.values(result.failures))
                                    notify(req.trans, error, "write");
                            }
                            return result;
                        }, (error) => {
                            notify(req.trans, error, "write");
                            throw error;
                        }),
                    };
                },
                transaction: (stores, mode, options) => {
                    let tx;
                    try {
                        tx = core.transaction(stores, mode, options);
                    }
                    catch (error) {
                        this.report(error, mode === "readonly" ? "read" : "write");
                        throw error;
                    }
                    const state = {
                        error: undefined,
                        reported: false,
                        intentional: false,
                    };
                    states.set(tx, state);
                    const abort = tx.abort;
                    tx.abort = function () {
                        state.intentional = true;
                        return abort.call(this);
                    };
                    // Capture before Dexie handles the request error and deliberately rolls back.
                    tx.addEventListener("error", (event) => {
                        if (state.reported || state.intentional)
                            return;
                        state.error =
                            event.target?.error ?? tx.error;
                    }, true);
                    tx.addEventListener("abort", () => {
                        if (!state.reported && !state.intentional) {
                            this.report(tx.error ?? { name: "AbortError" }, "commit");
                        }
                    });
                    return tx;
                },
            }),
        });
    }
}
