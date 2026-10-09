// Public selector constants shared by the browser (index.js) and Node.js
// (node-index.js) entries, so both export the same frozen objects. Keep this
// module free of imports and side effects: the Node test harness reads it
// without loading the native addon.

// Faucet-kind selector for accounts.create({ type }). A string, so it cannot
// be confused with the native AccountType visibility enum (Private = 0,
// Public = 1). create() still accepts the legacy numeric 0 and 1.
export const FaucetType = Object.freeze({
  FungibleFaucet: "FungibleFaucet",
});

export const AuthScheme = Object.freeze({
  Falcon: "falcon",
  ECDSA: "ecdsa",
});

export const NoteVisibility = Object.freeze({
  Public: "public",
  Private: "private",
});

export const StorageMode = Object.freeze({
  Public: "public",
  Private: "private",
});

export const Linking = Object.freeze({
  Dynamic: "dynamic",
  Static: "static",
});
