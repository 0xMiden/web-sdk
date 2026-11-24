import {
  VaultAsset,
  NoteAssets,
  NoteAttachment,
  Word,
  type Asset,
  type AccountId,
} from "@miden-sdk/miden-sdk";
import {
  VaultAsset as LazyVaultAsset,
  type Asset as LazyAsset,
} from "@miden-sdk/miden-sdk/lazy";
import {
  VaultAsset as MtVaultAsset,
  type Asset as MtAsset,
} from "@miden-sdk/miden-sdk/mt";
import {
  VaultAsset as MtLazyVaultAsset,
  type Asset as MtLazyAsset,
} from "@miden-sdk/miden-sdk/mt/lazy";

declare const faucetId: AccountId;
declare const key: Word;
declare const value: Word;

const payment: Asset = { token: faucetId, amount: 100n };
const lazyPayment: LazyAsset = payment;
const mtPayment: MtAsset = payment;
const mtLazyPayment: MtLazyAsset = payment;

new NoteAssets([VaultAsset.fungible(faucetId, BigInt(payment.amount))]);
new NoteAssets([LazyVaultAsset.nonFungible({ key, value })]);
new NoteAssets([MtVaultAsset.fungible(faucetId, BigInt(mtPayment.amount))]);
new NoteAssets([MtLazyVaultAsset.nonFungible({ key, value })]);

// u64 vector arguments accept a BigUint64Array or a bigint[], and the optional one may be omitted.
new Word(new BigUint64Array([0n, 0n, 0n, 0n]));
new Word([1n, 2n, 3n, 4n]);
new NoteAttachment();
new NoteAttachment(null);
new NoteAttachment(undefined);
new NoteAttachment(BigUint64Array.from([7n]));
new NoteAttachment([7n]);
// @ts-expect-error a number[] is not a u64 vector
new Word([1, 2, 3, 4]);

export { payment, lazyPayment, mtPayment, mtLazyPayment };
