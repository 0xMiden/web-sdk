import {
  isStandardPaymentNote,
  resolveAccountRef,
  resolveNoteType,
} from "./utils.js";

const SIGN_BYTES_DOMAIN_TAG = "miden-wallet/sign-bytes/v1";

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
 * True when the note runs the standard P2ID or P2IDE payment script.
 *
 * @param {ConsumableNoteRecord | InputNoteRecord} record - The note to check.
 * @returns {boolean} True for a P2ID or P2IDE note.
 */
export function isStandardPayment(record) {
  return isStandardPaymentNote(record, getWasm());
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

function fungibleAssetsFrom(assets, wasm) {
  const assetArray = Array.isArray(assets) ? assets : [assets];
  return assetArray.map((asset) => {
    const faucetId = resolveAccountRef(asset.token, wasm);
    return new wasm.FungibleAsset(faucetId, BigInt(asset.amount));
  });
}

function buildNoteAssets(assets, wasm) {
  const fungibleAssets = fungibleAssetsFrom(assets, wasm);
  if (fungibleAssets.length === 0) {
    throw new TypeError("P2ID and P2IDE notes require at least one asset");
  }
  return new wasm.NoteAssets(fungibleAssets);
}

/**
 * Builds a Public custom-script note carrying a NetworkAccountTarget attachment
 * (does not submit). Provide exactly one of `recipient` or `script`.
 *
 * Since 0.17 the kernel prices such a note by invoking a procedure on the target
 * account, so the transaction that emits it must declare that account as a
 * foreign account - on a fee-free chain too:
 *
 * ```js
 * const targets = new ForeignAccountArray();
 * targets.push(ForeignAccount.public(targetId, new AccountStorageRequirements()));
 * builder.withOwnOutputNotes(notes).withForeignAccounts(targets).build();
 * ```
 *
 * `client.transactions.createNetworkNote` does this for you; this function only
 * builds the note, so its caller owns that declaration.
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

  // A network note may carry no assets, so an empty array is valid here.
  const noteAssets = opts.assets
    ? new wasm.NoteAssets(fungibleAssetsFrom(opts.assets, wasm))
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

/**
 * Computes the commitment Bread signs for a dApp's `signBytes` request, so a
 * dApp can check the returned signature with
 * `publicKey.verify(domainSeparatedSignCommitment(data, kind), signature)`.
 *
 * The wallet signs under a domain tag. The tag is the Poseidon2 hash of the
 * string `miden-wallet/sign-bytes/v1`, one field element per UTF-8 byte; its
 * four elements are `0x38a8bcdddf30cacf`, `0x240d1b8455bc2c58`,
 * `0x18162f6af29602dd` and `0x5385955edcd341a4`. What is signed per `kind`:
 *
 * - `"word"`: `data` is a serialized `Word`. The signed commitment is that of
 *   `SigningInputs.newArbitrary([...tag, ...word.toFelts()])`.
 * - `"signingInputs"`: `data` is serialized `SigningInputs`. A Blind payload
 *   signs `[...tag, ...word.toFelts()]`, an Arbitrary payload signs
 *   `[...tag, ...payload]` (the tag alone when the payload is empty), both as
 *   Arbitrary inputs. A TransactionSummary is signed unchanged, so its own
 *   commitment is returned.
 *
 * Any other `kind` or variant throws. Wallets released before this change
 * signed the raw value instead.
 *
 * Needs the SDK's WASM to be loaded: with a lazy entry, await
 * `MidenClient.ready()` first.
 *
 * @param {Uint8Array} data - The serialized payload the dApp sent.
 * @param {"word" | "signingInputs"} kind - The request kind.
 * @returns {Word} The commitment the wallet signed.
 */
export function domainSeparatedSignCommitment(data, kind) {
  const wasm = getWasm();
  const sign = (payload) => {
    // The browser binding consumes Felts and FeltArrays by value, so build
    // fresh ones for every call instead of reusing any.
    const tagInput = new wasm.FeltArray(
      Array.from(
        new TextEncoder().encode(SIGN_BYTES_DOMAIN_TAG),
        (b) => new wasm.Felt(BigInt(b))
      )
    );
    const tag = wasm.Poseidon2.hashElements(tagInput).toFelts();
    const felts = [...tag, ...payload.map((f) => new wasm.Felt(f.asInt()))];
    return wasm.SigningInputs.newArbitrary(felts).toCommitment();
  };

  if (kind === "word") {
    return sign(wasm.Word.deserialize(data).toFelts());
  }
  if (kind !== "signingInputs") {
    throw new Error(`Unknown sign kind: ${String(kind)}`);
  }
  const inputs = wasm.SigningInputs.deserialize(data);
  const types = wasm.SigningInputsType;
  switch (inputs.variantType) {
    case types.TransactionSummary:
      return inputs.toCommitment();
    case types.Blind:
      return sign(inputs.blindPayload().toFelts());
    case types.Arbitrary: {
      // FeltArray (length()/get(i)) in the browser, a plain array on Node.
      const payload = inputs.arbitraryPayload();
      const felts = Array.isArray(payload)
        ? payload
        : Array.from({ length: payload.length() }, (_, i) => payload.get(i));
      return sign(felts);
    }
    default:
      throw new Error("Unsupported SigningInputs variant");
  }
}
