import {
  VaultAsset,
  NoteAssets,
  type Asset,
  type AccountId,
  type Word,
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

export { payment, lazyPayment, mtPayment, mtLazyPayment };
