/** @public */
export interface MidenClientOpts {
  endpoint?: string;
  /**
   * Note transport URL. Defaults to the transport for a recognized network
   * endpoint; unknown, custom, proxied, or relative endpoints (for example,
   * `"/rpc.Api"`) default to the testnet transport. Set this explicitly when
   * such an endpoint targets another network.
   */
  noteTransportUrl?: string;
  /**
   * @deprecated Use noteTransportUrl instead
   */
  nodeTransportUrl?: string;
  seed?: string;
  /** Optional callback timeout in milliseconds. Omitted leaves signing unlimited. */
  callbackTimeoutMs?: number;
}

export type MidenAccountStorageMode = "public" | "private";

export interface MidenAccountOpts {
  accountSeed?: string;
  storageMode: MidenAccountStorageMode;
}
export type Opts = MidenClientOpts & MidenAccountOpts;

interface NoteIdAndAsset {
  id: string;
  assets: {
    assetId: string;
    amount: string;
  }[];
}

interface InputNoteSender {
  sender: string;
}

interface OutputNoteType {
  noteType: string;
}

export interface TxSummaryJson {
  inputNotes: (NoteIdAndAsset & InputNoteSender)[];
  outputNotes: (NoteIdAndAsset & OutputNoteType)[];
}
