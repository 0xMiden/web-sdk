import { resolveAccountRef, resolveNoteType } from "./utils.js";

// Module-level WASM reference, set by index.js after initialization
let _wasm = null;
let _WebClient = null;

export function _setWasm(wasm) {
  _wasm = wasm;
}

export function _setWebClient(WebClientClass) {
  _WebClient = WebClientClass;
}

function getWasm() {
  if (!_wasm) {
    throw new Error(
      "WASM not initialized. Ensure the SDK is loaded before calling standalone utilities."
    );
  }
  return _wasm;
}

/**
 * Creates a P2ID (Pay-to-ID) note.
 *
 * @param {NoteOptions} opts - Note creation options.
 * @returns {Note} The created note.
 */
export function createP2IDNote(opts) {
  const wasm = getWasm();
  const sender = resolveAccountRef(opts.from, wasm);
  const target = resolveAccountRef(opts.to, wasm);
  const noteAssets = buildNoteAssets(opts.assets, wasm);
  const noteType = resolveNoteType(opts.type, wasm);
  const attachment = opts.attachment
    ? new wasm.NoteAttachment(opts.attachment)
    : new wasm.NoteAttachment([]);

  return wasm.Note.createP2IDNote(
    sender,
    target,
    noteAssets,
    noteType,
    attachment
  );
}

/**
 * Creates a P2IDE (Pay-to-ID with Expiration) note.
 *
 * @param {P2IDEOptions} opts - Note creation options with timelock/reclaim.
 * @returns {Note} The created note.
 */
export function createP2IDENote(opts) {
  const wasm = getWasm();
  const sender = resolveAccountRef(opts.from, wasm);
  const target = resolveAccountRef(opts.to, wasm);
  const noteAssets = buildNoteAssets(opts.assets, wasm);
  const noteType = resolveNoteType(opts.type, wasm);
  const attachment = opts.attachment
    ? new wasm.NoteAttachment(opts.attachment)
    : new wasm.NoteAttachment([]);

  return wasm.Note.createP2IDENote(
    sender,
    target,
    noteAssets,
    opts.reclaimAfter,
    opts.timelockUntil,
    noteType,
    attachment
  );
}

/**
 * Builds a swap tag for note matching.
 *
 * @param {BuildSwapTagOptions} opts - Swap tag options.
 * @returns {NoteTag} The computed swap tag.
 */
export function buildSwapTag(opts) {
  const wasm = getWasm();
  if (!_WebClient || typeof _WebClient.buildSwapTag !== "function") {
    throw new Error(
      "WebClient.buildSwapTag is not available. Ensure the SDK is fully loaded."
    );
  }
  const noteType = resolveNoteType(opts.type, wasm);
  const offeredFaucetId = resolveAccountRef(opts.offer.token, wasm);
  const requestedFaucetId = resolveAccountRef(opts.request.token, wasm);

  return _WebClient.buildSwapTag(
    noteType,
    offeredFaucetId,
    BigInt(opts.offer.amount),
    requestedFaucetId,
    BigInt(opts.request.amount)
  );
}

function buildNoteAssets(assets, wasm) {
  const assetArray = Array.isArray(assets) ? assets : [assets];
  if (assetArray.length === 0) {
    throw new TypeError("P2ID and P2IDE notes require at least one asset");
  }
  const fungibleAssets = assetArray.map((asset) => {
    const faucetId = resolveAccountRef(asset.token, wasm);
    return new wasm.FungibleAsset(faucetId, BigInt(asset.amount));
  });
  return new wasm.NoteAssets(fungibleAssets);
}

/**
 * Builds a Public custom-script note carrying a NetworkAccountTarget attachment
 * (does not submit). Provide exactly one of `recipient` or `script`.
 *
 * @param {NetworkNoteOptions} opts
 * @returns {Note}
 */
export function buildNetworkNote(opts) {
  const wasm = getWasm();
  if (opts.recipient && opts.script) {
    throw new Error(
      "buildNetworkNote requires exactly one of `recipient` or `script`, not both."
    );
  }
  const sender = resolveAccountRef(opts.account, wasm);

  const target =
    opts.target instanceof wasm.NetworkAccountTarget
      ? opts.target
      : new wasm.NetworkAccountTarget(
          resolveAccountRef(opts.target, wasm),
          opts.executionHint
        );

  const noteAssets = opts.assets
    ? buildNoteAssets(opts.assets, wasm)
    : new wasm.NoteAssets();

  const metadata = new wasm.NoteMetadata(
    sender,
    wasm.NoteType.Public,
    wasm.NoteTag.withAccountTarget(target.targetId())
  );

  const recipient = opts.recipient ?? buildRecipient(opts, wasm);

  const attachments = [target.toAttachment()];
  if (opts.attachment) {
    attachments.push(new wasm.NoteAttachment(opts.attachment));
  }

  return wasm.Note.withAttachments(
    noteAssets,
    metadata,
    recipient,
    attachments
  );
}

function buildRecipient(opts, wasm) {
  if (!opts.script) {
    throw new Error(
      "buildNetworkNote requires either `recipient` or `script`."
    );
  }
  const storage = new wasm.NoteStorage(
    new wasm.FeltArray((opts.inputs ?? []).map((value) => new wasm.Felt(value)))
  );
  return wasm.NoteRecipient.fromScript(opts.script, storage);
}
