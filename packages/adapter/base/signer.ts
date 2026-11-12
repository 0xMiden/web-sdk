import type { NoteFilterTypes } from "@miden-sdk/miden-sdk";
import type { WalletAdapter, WalletAdapterProps } from "./adapter";
import { BaseWalletAdapter } from "./adapter";
import {
  MidenConsumeTransaction,
  MidenSendTransaction,
  MidenTransaction,
} from "./transaction";
import {
  Asset,
  CreateAccountParams,
  GuardianInfo,
  InputNoteDetails,
  SignKind,
  TransactionOutput,
} from "./types";

export type Adapter =
  | WalletAdapter
  | SignerWalletAdapter
  | MessageSignerWalletAdapter;

export interface SignerWalletAdapterProps<
  Name extends string = string,
> extends WalletAdapterProps<Name> {}

export type SignerWalletAdapter<Name extends string = string> =
  WalletAdapter<Name> & SignerWalletAdapterProps<Name>;

export abstract class BaseSignerWalletAdapter<Name extends string = string>
  extends BaseWalletAdapter<Name>
  implements SignerWalletAdapter<Name> {}

export interface MessageSignerWalletAdapterProps<
  Name extends string = string,
> extends WalletAdapterProps<Name> {
  requestTransaction(transaction: MidenTransaction): Promise<string>;
  requestAssets(): Promise<Asset[]>;
  requestGuardianInfo(): Promise<GuardianInfo>;
  requestPrivateNotes(
    noteFilterType: NoteFilterTypes,
    noteIds?: string[]
  ): Promise<InputNoteDetails[]>;
  /**
   * Signs `data` with the connected account's key and returns the signature.
   *
   * Per kind, the wallet signs: `"word"` and a `"signingInputs"` Blind or
   * Arbitrary payload, the domain-separated commitment
   * `domainSeparatedSignCommitment(data, kind)` from `@miden-sdk/miden-sdk`;
   * a `"signingInputs"` transaction summary, its own commitment.
   *
   * The result carries no scheme signal: the adapter returns only the
   * signature. Current wallets:
   * `publicKey.verify(domainSeparatedSignCommitment(data, kind), signature)`.
   * Older wallets signed the raw value. A dApp that also accepts wallets
   * released before this scheme can optionally check that value: for
   * `"word"`, `publicKey.verify(Word.deserialize(data), signature)`; for
   * `"signingInputs"`,
   * `publicKey.verifyData(SigningInputs.deserialize(data), signature)`. A
   * transaction summary's commitment is the same in both generations, so the
   * current check already covers it.
   */
  signBytes(data: Uint8Array, kind: SignKind): Promise<Uint8Array>;
  importPrivateNote(note: Uint8Array): Promise<string>;
  requestConsumableNotes(): Promise<InputNoteDetails[]>;
  waitForTransaction(
    txId: string,
    timeout?: number
  ): Promise<TransactionOutput>;
  requestSend(transaction: MidenSendTransaction): Promise<string>;
  requestConsume(transaction: MidenConsumeTransaction): Promise<string>;
  createAccount(params?: CreateAccountParams): Promise<string>;
}

export type MessageSignerWalletAdapter<Name extends string = string> =
  WalletAdapter<Name> & MessageSignerWalletAdapterProps<Name>;

export abstract class BaseMessageSignerWalletAdapter<
  Name extends string = string,
>
  extends BaseSignerWalletAdapter<Name>
  implements MessageSignerWalletAdapter<Name>
{
  abstract requestSend(transaction: MidenSendTransaction): Promise<string>;
  abstract requestConsume(
    transaction: MidenConsumeTransaction
  ): Promise<string>;
  abstract requestTransaction(transaction: MidenTransaction): Promise<string>;
  abstract requestAssets(): Promise<Asset[]>;
  abstract requestGuardianInfo(): Promise<GuardianInfo>;
  abstract requestPrivateNotes(
    noteFilterType: NoteFilterTypes,
    noteIds?: string[]
  ): Promise<InputNoteDetails[]>;
  abstract signBytes(data: Uint8Array, kind: SignKind): Promise<Uint8Array>;
  abstract importPrivateNote(note: Uint8Array): Promise<string>;
  abstract requestConsumableNotes(): Promise<InputNoteDetails[]>;
  abstract waitForTransaction(
    txId: string,
    timeout?: number
  ): Promise<TransactionOutput>;
  abstract createAccount(params?: CreateAccountParams): Promise<string>;
}
