const kindByName = new Map([
    ["QuotaExceededError", "quota"],
    ["UnknownError", "io"],
    ["SecurityError", "unavailable"],
    ["InvalidStateError", "unavailable"],
    ["MissingAPIError", "unavailable"],
]);
function storageFailure(phase, error) {
    const seen = new WeakSet();
    while (error && typeof error === "object" && !seen.has(error)) {
        seen.add(error);
        const name = error.name;
        if (typeof name === "string") {
            const kind = kindByName.get(name);
            if (kind)
                return { phase, kind, errorName: name };
        }
        error = error.inner;
    }
    return undefined;
}
function notify(policies, failure) {
    if (!policies)
        return;
    for (const { onFailure } of policies) {
        try {
            void Promise.resolve(onFailure?.({ ...failure })).catch(() => { });
        }
        catch {
            // A notification cannot replace the original IndexedDB error.
        }
    }
}
export function reportOpenFailure(policies, error) {
    const failure = storageFailure("open", error);
    if (failure)
        notify(policies, failure);
}
export function installStoragePolicy(db, policies) {
    db.use({
        stack: "dbcore",
        name: "miden-storage-policy",
        create: (downlevel) => ({
            ...downlevel,
            transaction(stores, mode, options) {
                const active = policies();
                if (!active?.size)
                    return downlevel.transaction(stores, mode, options);
                const durabilities = Array.from(active.values(), ({ durability }) => durability);
                const durability = ["strict", "default", "relaxed"].find((value) => durabilities.includes(value));
                const requestPhase = mode === "readonly" ? "read" : "write";
                let transaction;
                try {
                    transaction = downlevel.transaction(stores, mode, durability && mode === "readwrite"
                        ? { ...options, durability }
                        : options);
                }
                catch (error) {
                    const failure = storageFailure(requestPhase, error);
                    if (failure)
                        notify(policies()?.values(), failure);
                    throw error;
                }
                let reported = false;
                const report = (phase, error) => {
                    if (reported)
                        return;
                    const failure = storageFailure(phase, error);
                    if (!failure)
                        return;
                    reported = true;
                    notify(policies()?.values(), failure);
                };
                transaction.addEventListener("error", (event) => report(requestPhase, event.target?.error));
                transaction.addEventListener("abort", () => report(requestPhase === "read" ? "read" : "commit", transaction.error));
                return transaction;
            },
        }),
    });
}
