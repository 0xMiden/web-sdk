import type {
  ConsumableNoteRecord,
  InputNoteRecord,
  Note,
  NoteInput,
  WasmWebClient as WebClient,
} from "@miden-sdk/miden-sdk";
import type { AssetMetadata, NoteAsset, NoteSummary } from "../types";
import { toBech32AccountId } from "./accountBech32";
import { formatAssetAmount } from "./amounts";

/**
 * Resolve a `NoteInput` (hex string | NoteId | InputNoteRecord | Note) to a
 * `Note`. String and `NoteId` inputs are looked up via `client.getInputNote`;
 * `InputNoteRecord` is unwrapped via `.toNote()`; a `Note` is returned as-is.
 *
 * Throws when the lookup is needed but the note is not present in the local
 * store. The error message includes the resolved hex id.
 */
export const resolveNoteInput = async (
  input: NoteInput,
  client: WebClient
): Promise<Note> => {
  if (typeof input === "string") {
    const record = await client.getInputNote(input);
    if (!record) {
      throw new Error(`Note not found: ${input}`);
    }
    return record.toNote();
  }
  // InputNoteRecord — exposes both .toNote() and .id(); check .toNote() first.
  if (typeof (input as InputNoteRecord).toNote === "function") {
    return (input as InputNoteRecord).toNote();
  }
  // Note — has .id() but no .toNote().
  if (typeof (input as Note).id === "function") {
    return input as Note;
  }
  // NoteId — has .toString() only; look up by hex. The JS-bridge equivalent
  // (#resolveNoteInput in crates/web-client/js/resources/transactions.js) also
  // gates this on `input.constructor?.fromHex !== undefined`; we skip that
  // here because (a) the `NoteInput` type already constrains callers to one
  // of the four valid shapes, and (b) hitting this branch with a garbage
  // object yields a clear "Note not found: <stringified>" rather than a
  // downstream WASM type error.
  const hex = input.toString();
  const record = await client.getInputNote(hex);
  if (!record) {
    throw new Error(`Note not found: ${hex}`);
  }
  return record.toNote();
};

const getInputNoteRecord = (
  note: ConsumableNoteRecord | InputNoteRecord
): InputNoteRecord => {
  const maybeConsumable = note as ConsumableNoteRecord;
  if (typeof maybeConsumable.inputNoteRecord === "function") {
    return maybeConsumable.inputNoteRecord();
  }
  return note as InputNoteRecord;
};

export const getNoteSummary = (
  note: ConsumableNoteRecord | InputNoteRecord,
  getAssetMetadata?: (assetId: string) => AssetMetadata | undefined
): NoteSummary | null => {
  try {
    const record = getInputNoteRecord(note);
    const id = record.id().toString();
    const assets: NoteAsset[] = [];

    try {
      const details = record.details();
      const assetsList = details?.assets?.().fungibleAssets?.() ?? [];
      for (const asset of assetsList) {
        const assetId = asset.faucetId().toString();
        const metadata = getAssetMetadata?.(assetId);
        assets.push({
          assetId,
          amount: BigInt(asset.amount() as number | bigint),
          symbol: metadata?.symbol,
          decimals: metadata?.decimals,
        });
      }
    } catch {
      // Keep assets empty if details are unavailable.
    }

    const metadata = record.metadata?.();
    const senderHex = metadata?.sender?.()?.toString?.();
    const sender = senderHex ? toBech32AccountId(senderHex) : undefined;

    return { id, assets, sender };
  } catch {
    return null;
  }
};

export const formatNoteSummary = (
  summary: NoteSummary,
  formatAsset: (asset: NoteAsset) => string = (asset) =>
    `${formatAssetAmount(asset.amount, asset.decimals)} ${
      asset.symbol ?? asset.assetId
    }`
): string => {
  if (!summary.assets.length) {
    return summary.id;
  }

  const assetsText = summary.assets.map(formatAsset).join(" + ");
  return summary.sender ? `${assetsText} from ${summary.sender}` : assetsText;
};
