use alloc::collections::BTreeMap;
use core::cmp::Ordering;
use core::error::Error;

use js_export_macro::js_export;
use miden_client::account::{AccountDelta as NativeAccountDelta, AccountId as NativeAccountId};
use miden_client::asset::{AccountVaultDelta, Asset, AssetAmount, FungibleAsset};
use miden_client::note::{BlockNumber, Note as NativeNote, PswapNote};
#[cfg(feature = "testing")]
use miden_client::transaction::LocalTransactionProver;
use miden_client::transaction::{
    ExecutedTransaction as NativeExecutedTransaction,
    ForeignAccount as NativeForeignAccount,
    PaymentNoteDescription,
    ProvenTransaction as NativeProvenTransaction,
    PswapTransactionData,
    SwapTransactionData,
    TransactionExecutorError,
    TransactionRequest as NativeTransactionRequest,
    TransactionRequestBuilder as NativeTransactionRequestBuilder,
    TransactionStoreUpdate as NativeTransactionStoreUpdate,
    TransactionSummary as NativeTransactionSummary,
};
use miden_client::{ClientError, Felt as NativeFelt};

use crate::models::NoteType;
use crate::models::account_id::AccountId;
use crate::models::advice_inputs::AdviceInputs;
use crate::models::felt::Felt;
use crate::models::miden_arrays::{FeltArray, ForeignAccountArray};
use crate::models::note::Note;
use crate::models::proven_transaction::ProvenTransaction;
use crate::models::provers::TransactionProver;
use crate::models::transaction_id::TransactionId;
use crate::models::transaction_request::TransactionRequest;
use crate::models::transaction_result::TransactionResult;
use crate::models::transaction_script::TransactionScript;
use crate::models::transaction_store_update::TransactionStoreUpdate;
use crate::models::transaction_summary::TransactionSummary;
use crate::platform::{JsErr, from_str_err, js_u64_to_u64, maybe_wrap_send};
use crate::{WebClient, js_error_with_context};

fn vault_delta_error<T>(err: T) -> JsErr
where
    T: Error + 'static,
{
    js_error_with_context(err, "failed to construct the vault delta for transaction summary")
}

fn add_fungible_change(
    vault_delta: &mut AccountVaultDelta,
    initial: FungibleAsset,
    final_asset: FungibleAsset,
) -> Result<(), JsErr> {
    let initial_amount = initial.amount().as_u64();
    let final_amount = final_asset.amount().as_u64();

    match final_amount.cmp(&initial_amount) {
        Ordering::Greater => {
            let asset = FungibleAsset::new(final_asset.faucet_id(), final_amount - initial_amount)
                .map_err(vault_delta_error)?;
            vault_delta.add_asset(asset.into()).map_err(vault_delta_error)
        },
        Ordering::Less => {
            let asset = FungibleAsset::new(initial.faucet_id(), initial_amount - final_amount)
                .map_err(vault_delta_error)?;
            vault_delta.remove_asset(asset.into()).map_err(vault_delta_error)
        },
        Ordering::Equal => Ok(()),
    }
}

fn add_asset_change(
    vault_delta: &mut AccountVaultDelta,
    initial_asset: Option<Asset>,
    final_asset: Option<Asset>,
) -> Result<(), JsErr> {
    match (initial_asset, final_asset) {
        (None, Some(asset)) => vault_delta.add_asset(asset).map_err(vault_delta_error),
        (Some(asset), None) => vault_delta.remove_asset(asset).map_err(vault_delta_error),
        (Some(Asset::Fungible(initial)), Some(Asset::Fungible(final_asset))) => {
            add_fungible_change(vault_delta, initial, final_asset)
        },
        (Some(Asset::NonFungible(initial)), Some(Asset::NonFungible(final_asset))) => {
            if initial == final_asset {
                Ok(())
            } else {
                Err(from_str_err(
                    "cannot construct a transaction summary for a non-fungible asset replacement",
                ))
            }
        },
        (None, None) => Ok(()),
        (Some(_), Some(_)) => {
            Err(from_str_err("cannot construct a transaction summary for an asset type change"))
        },
    }
}

#[cfg(test)]
mod tests {
    use miden_client::testing::account_id::ACCOUNT_ID_PRIVATE_FUNGIBLE_FAUCET;

    use super::*;

    #[test]
    fn absolute_fungible_asset_values_are_converted_to_relative_deltas() {
        let faucet_id = NativeAccountId::try_from(ACCOUNT_ID_PRIVATE_FUNGIBLE_FAUCET)
            .expect("test faucet ID should be valid");
        let initial = FungibleAsset::new(faucet_id, 100).expect("test asset should be valid");
        let final_asset = FungibleAsset::new(faucet_id, 40).expect("test asset should be valid");
        let asset_id = initial.id();
        let mut vault_delta = AccountVaultDelta::default();

        add_asset_change(&mut vault_delta, Some(initial.into()), Some(final_asset.into()))
            .expect("valid absolute values should produce a relative delta");

        assert_eq!(vault_delta.fungible().amount(&asset_id), Some(-60));
    }
}

/// Reconstructs the relative account delta committed to by a transaction summary from the
/// absolute account patch retained by an executed transaction.
///
/// Storage patches already have identical semantics in `AccountDelta` and `AccountPatch`. Vault
/// patches, however, contain final absolute values, so the authenticated pre-state witnesses in
/// the transaction inputs are used to recover each relative asset change.
fn account_delta_from_executed_transaction(
    executed_tx: &NativeExecutedTransaction,
) -> Result<NativeAccountDelta, JsErr> {
    let account_patch = executed_tx.account_patch();
    let tx_inputs = executed_tx.tx_inputs();
    let initial_account = executed_tx.initial_account();
    let initial_vault_root = initial_account.vault().root();
    let mut vault_delta = AccountVaultDelta::default();

    for (&asset_id, &final_value) in account_patch.vault().iter() {
        let initial_asset =
            tx_inputs.read_vault_asset(initial_vault_root, asset_id).map_err(|err| {
                js_error_with_context(
                    err,
                    "failed to read an initial vault asset while constructing transaction summary",
                )
            })?;
        let final_asset = if final_value.is_empty() {
            None
        } else {
            Some(Asset::from_id_and_value(asset_id, final_value).map_err(|err| {
                js_error_with_context(
                    err,
                    "failed to read a final vault asset while constructing transaction summary",
                )
            })?)
        };

        add_asset_change(&mut vault_delta, initial_asset, final_asset)?;
    }

    let nonce_delta = match account_patch.final_nonce() {
        Some(final_nonce) => {
            let initial_nonce = initial_account.nonce().as_canonical_u64();
            let final_nonce = final_nonce.as_canonical_u64();
            let nonce_delta = final_nonce.checked_sub(initial_nonce).ok_or_else(|| {
                from_str_err("final account nonce is lower than its initial nonce")
            })?;
            NativeFelt::try_from(nonce_delta).map_err(|err| {
                js_error_with_context(
                    err,
                    "failed to construct the nonce delta for transaction summary",
                )
            })?
        },
        None => NativeFelt::ZERO,
    };

    NativeAccountDelta::new(
        account_patch.id(),
        account_patch.storage().clone(),
        vault_delta,
        account_patch.code().cloned(),
        nonce_delta,
    )
    .map_err(|err| {
        js_error_with_context(err, "failed to construct account delta for transaction summary")
    })
}

#[js_export]
impl WebClient {
    #[js_export(js_name = "newMintTransactionRequest")]
    pub async fn new_mint_transaction_request(
        &self,
        target_account_id: &AccountId,
        faucet_id: &AccountId,
        note_type: NoteType,
        amount: JsU64,
    ) -> Result<TransactionRequest, JsErr> {
        let amount = js_u64_to_u64(amount);
        let fungible_asset = FungibleAsset::new(faucet_id.into(), amount)
            .map_err(|err| js_error_with_context(err, "failed to create fungible asset"))?;

        let mint_transaction_request = {
            let mut guard = self.get_mut_inner().await;
            let client = guard.as_mut().ok_or_else(|| {
                from_str_err("Client not initialized while generating transaction request")
            })?;

            NativeTransactionRequestBuilder::new()
                .build_mint_fungible_asset(
                    fungible_asset,
                    target_account_id.into(),
                    note_type.into(),
                    client.rng(),
                )
                .map_err(|err| {
                    js_error_with_context(err, "failed to create mint transaction request")
                })?
        };

        Ok(mint_transaction_request.into())
    }

    #[js_export(js_name = "newSendTransactionRequest")]
    #[allow(clippy::too_many_arguments)]
    pub async fn new_send_transaction_request(
        &self,
        sender_account_id: &AccountId,
        target_account_id: &AccountId,
        faucet_id: &AccountId,
        note_type: NoteType,
        amount: JsU64,
        recall_height: Option<u32>,
        timelock_height: Option<u32>,
    ) -> Result<TransactionRequest, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| {
            from_str_err("Client not initialized while generating transaction request")
        })?;

        let amount = js_u64_to_u64(amount);
        let fungible_asset = FungibleAsset::new(faucet_id.into(), amount)
            .map_err(|err| js_error_with_context(err, "failed to create fungible asset"))?;

        let mut payment_description = PaymentNoteDescription::new(
            vec![fungible_asset.into()],
            sender_account_id.into(),
            target_account_id.into(),
        );

        if let Some(recall_height) = recall_height {
            payment_description =
                payment_description.with_reclaim_height(BlockNumber::from(recall_height));
        }

        if let Some(height) = timelock_height {
            payment_description =
                payment_description.with_timelock_height(BlockNumber::from(height));
        }

        let send_transaction_request = NativeTransactionRequestBuilder::new()
            .build_pay_to_id(payment_description, note_type.into(), client.rng())
            .map_err(|err| {
                js_error_with_context(err, "failed to create send transaction request")
            })?;

        Ok(send_transaction_request.into())
    }

    #[js_export(js_name = "newSwapTransactionRequest")]
    #[allow(clippy::too_many_arguments)]
    pub async fn new_swap_transaction_request(
        &self,
        sender_account_id: &AccountId,
        offered_asset_faucet_id: &AccountId,
        offered_asset_amount: JsU64,
        requested_asset_faucet_id: &AccountId,
        requested_asset_amount: JsU64,
        note_type: NoteType,
        payback_note_type: NoteType,
    ) -> Result<TransactionRequest, JsErr> {
        let offered_asset_amount = js_u64_to_u64(offered_asset_amount);
        let offered_fungible_asset =
            FungibleAsset::new(offered_asset_faucet_id.into(), offered_asset_amount)
                .map_err(|err| {
                    js_error_with_context(err, "failed to create offered fungible asset")
                })?
                .into();

        let requested_asset_amount = js_u64_to_u64(requested_asset_amount);
        let requested_fungible_asset =
            FungibleAsset::new(requested_asset_faucet_id.into(), requested_asset_amount)
                .map_err(|err| {
                    js_error_with_context(err, "failed to create requested fungible asset")
                })?
                .into();

        let swap_transaction_data = SwapTransactionData::new(
            sender_account_id.into(),
            offered_fungible_asset,
            requested_fungible_asset,
        );

        let swap_transaction_request = {
            let mut guard = self.get_mut_inner().await;
            let client = guard.as_mut().ok_or_else(|| {
                from_str_err("Client not initialized while generating transaction request")
            })?;

            NativeTransactionRequestBuilder::new()
                .build_swap(
                    &swap_transaction_data,
                    note_type.into(),
                    payback_note_type.into(),
                    client.rng(),
                )
                .map_err(|err| {
                    js_error_with_context(err, "failed to create swap transaction request")
                })?
        };

        Ok(swap_transaction_request.into())
    }

    #[js_export(js_name = "newPswapCreateTransactionRequest")]
    #[allow(clippy::too_many_arguments)]
    pub async fn new_pswap_create_transaction_request(
        &self,
        creator_account_id: &AccountId,
        offered_asset_faucet_id: &AccountId,
        offered_asset_amount: JsU64,
        requested_asset_faucet_id: &AccountId,
        requested_asset_amount: JsU64,
        note_type: NoteType,
        payback_note_type: NoteType,
    ) -> Result<TransactionRequest, JsErr> {
        let offered_asset_amount = js_u64_to_u64(offered_asset_amount);
        let offered_fungible_asset =
            FungibleAsset::new(offered_asset_faucet_id.into(), offered_asset_amount).map_err(
                |err| js_error_with_context(err, "failed to create offered fungible asset"),
            )?;

        let requested_asset_amount = js_u64_to_u64(requested_asset_amount);
        let requested_fungible_asset =
            FungibleAsset::new(requested_asset_faucet_id.into(), requested_asset_amount).map_err(
                |err| js_error_with_context(err, "failed to create requested fungible asset"),
            )?;

        let pswap_transaction_data = PswapTransactionData::new(
            creator_account_id.into(),
            offered_fungible_asset,
            requested_fungible_asset,
        );

        let pswap_transaction_request = {
            let mut guard = self.get_mut_inner().await;
            let client = guard.as_mut().ok_or_else(|| {
                from_str_err("Client not initialized while generating transaction request")
            })?;

            NativeTransactionRequestBuilder::new()
                .build_pswap_create(
                    &pswap_transaction_data,
                    note_type.into(),
                    payback_note_type.into(),
                    // V1 limitation: PSWAP notes always use no attachment — it
                    // is not yet exposed to JS callers. Follow-up: surface an
                    // optional `attachment` field on PswapCreateOptions in a
                    // non-breaking way. Until then, do not change this `None`
                    // without bumping existing PSWAP note compatibility.
                    //
                    // (`NoteAttachment::default()` no longer exists on the
                    // 0.15 surface — `Option::None` is the new way to say
                    // "no attachment".)
                    None,
                    client.rng(),
                )
                .map_err(|err| {
                    js_error_with_context(err, "failed to create PSWAP create transaction request")
                })?
        };

        Ok(pswap_transaction_request.into())
    }

    #[js_export(js_name = "newPswapConsumeTransactionRequest")]
    pub fn new_pswap_consume_transaction_request(
        &self,
        pswap_note: &Note,
        consumer_account_id: &AccountId,
        account_fill_amount: JsU64,
        note_fill_amount: JsU64,
    ) -> Result<TransactionRequest, JsErr> {
        let native_pswap_note: NativeNote = pswap_note.into();
        let pswap = PswapNote::try_from(&native_pswap_note)
            .map_err(|err| js_error_with_context(err, "invalid PSWAP note"))?;

        let account_fill_amount = AssetAmount::new(js_u64_to_u64(account_fill_amount))
            .map_err(|err| js_error_with_context(err, "invalid account fill amount"))?;
        let note_fill_amount = AssetAmount::new(js_u64_to_u64(note_fill_amount))
            .map_err(|err| js_error_with_context(err, "invalid note fill amount"))?;

        // miden-client 0.16 treats an overfill as a full fill. Keep the web client's existing
        // contract, which rejects fills outside the open order amount, and validate the combined
        // account/note fill before handing it to the native request builder.
        let total_fill_amount = (account_fill_amount + note_fill_amount)
            .map_err(|err| js_error_with_context(err, "invalid total fill amount"))?;
        if total_fill_amount == AssetAmount::ZERO {
            return Err(from_str_err("Fill amount must be greater than 0"));
        }

        let requested_amount = pswap.storage().min_requested_asset().amount();
        if total_fill_amount > requested_amount {
            return Err(from_str_err(&format!(
                "Fill amount {total_fill_amount} exceeds requested amount {requested_amount}"
            )));
        }

        let pswap_transaction_request = NativeTransactionRequestBuilder::new()
            .build_pswap_consume(
                &native_pswap_note,
                consumer_account_id.into(),
                account_fill_amount,
                note_fill_amount,
            )
            .map_err(|err| {
                js_error_with_context(err, "failed to create PSWAP consume transaction request")
            })?;

        Ok(pswap_transaction_request.into())
    }

    #[js_export(js_name = "newPswapCancelTransactionRequest")]
    pub fn new_pswap_cancel_transaction_request(
        &self,
        pswap_note: &Note,
        creator_account_id: &AccountId,
    ) -> Result<TransactionRequest, JsErr> {
        let native_pswap_note: NativeNote = pswap_note.into();

        let pswap_transaction_request = NativeTransactionRequestBuilder::new()
            .build_pswap_cancel(native_pswap_note, creator_account_id.into())
            .map_err(|err| {
                js_error_with_context(err, "failed to create PSWAP cancel transaction request")
            })?;

        Ok(pswap_transaction_request.into())
    }

    /// Executes a transaction specified by the request against the specified account,
    /// proves it, submits it to the network, and updates the local database.
    ///
    /// Uses the prover configured for this client.
    ///
    /// If the transaction utilizes foreign account data, there is a chance that the client doesn't
    /// have the required block header in the local database. In these scenarios, a sync to
    /// the chain tip is performed, and the required block header is retrieved.
    #[js_export(js_name = "submitNewTransaction")]
    pub async fn submit_new_transaction(
        &self,
        account_id: &AccountId,
        transaction_request: &TransactionRequest,
    ) -> Result<TransactionId, JsErr> {
        let transaction_result = self.execute_transaction(account_id, transaction_request).await?;

        let tx_id = transaction_result.id();

        let proven_transaction = self.prove_transaction(&transaction_result, None).await?;

        let submission_height =
            self.submit_proven_transaction(&proven_transaction, &transaction_result).await?;
        self.apply_transaction(&transaction_result, submission_height).await?;

        Ok(tx_id)
    }

    /// Executes a transaction specified by the request against the specified account, proves it
    /// with the user provided prover, submits it to the network, and updates the local database.
    ///
    /// If the transaction utilizes foreign account data, there is a chance that the client doesn't
    /// have the required block header in the local database. In these scenarios, a sync to the
    /// chain tip is performed, and the required block header is retrieved.
    #[js_export(js_name = "submitNewTransactionWithProver")]
    pub async fn submit_new_transaction_with_prover(
        &self,
        account_id: &AccountId,
        transaction_request: &TransactionRequest,
        prover: &TransactionProver,
    ) -> Result<TransactionId, JsErr> {
        let transaction_result = self.execute_transaction(account_id, transaction_request).await?;

        let tx_id = transaction_result.id();

        let proven_transaction =
            self.prove_transaction(&transaction_result, Some(prover.clone())).await?;

        let submission_height =
            self.submit_proven_transaction(&proven_transaction, &transaction_result).await?;
        self.apply_transaction(&transaction_result, submission_height).await?;

        Ok(tx_id)
    }

    /// Executes a transaction specified by the request against the specified account but does not
    /// submit it to the network nor update the local database. The returned [`TransactionResult`]
    /// retains the execution artifacts needed to continue with the transaction lifecycle.
    ///
    /// If the transaction utilizes foreign account data, there is a chance that the client doesn't
    /// have the required block header in the local database. In these scenarios, a sync to
    /// the chain tip is performed, and the required block header is retrieved.
    #[js_export(js_name = "executeTransaction")]
    pub async fn execute_transaction(
        &self,
        account_id: &AccountId,
        transaction_request: &TransactionRequest,
    ) -> Result<TransactionResult, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let fut =
            Box::pin(client.execute_transaction(account_id.into(), transaction_request.into()));
        maybe_wrap_send(fut)
            .await
            .map(TransactionResult::from)
            .map_err(|err| js_error_with_context(err, "failed to execute transaction"))
    }

    /// Executes a transaction and returns the `TransactionSummary`.
    ///
    /// If the transaction is unauthorized (auth script emits the unauthorized event), returns the
    /// summary from the error. If the transaction succeeds, constructs a summary from the executed
    /// transaction using the `auth_arg` from the transaction request as the salt (or a zero salt if
    /// not provided).
    ///
    /// # Errors
    /// - If there is an internal failure during execution.
    #[js_export(js_name = "executeForSummary")]
    pub async fn execute_for_summary(
        &self,
        account_id: &AccountId,
        transaction_request: &TransactionRequest,
    ) -> Result<TransactionSummary, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let native_request: NativeTransactionRequest = transaction_request.into();
        // The auth argument is passed to the auth procedure as the transaction-summary salt.
        let salt = native_request.auth_arg().unwrap_or_default();

        let fut = Box::pin(client.execute_transaction(account_id.into(), native_request));
        let execute_result = maybe_wrap_send(fut).await;
        match execute_result {
            Ok(result) => {
                let executed_tx = result.executed_transaction();
                let account_delta = account_delta_from_executed_transaction(executed_tx)?;
                let summary = NativeTransactionSummary::new(
                    account_delta,
                    executed_tx.input_notes().clone(),
                    executed_tx.output_notes().clone(),
                    salt,
                );
                Ok(TransactionSummary::from(summary))
            },
            Err(ClientError::TransactionExecutorError(TransactionExecutorError::Unauthorized(
                summary,
            ))) => Ok(TransactionSummary::from(*summary)),
            Err(err) => Err(js_error_with_context(err, "failed to execute transaction")),
        }
    }

    /// Executes the provided transaction script against the specified account
    /// and returns the resulting stack output. This is a local-only "view call"
    /// that does not submit anything to the network.
    #[js_export(js_name = "executeProgram")]
    pub async fn execute_program(
        &self,
        account_id: &AccountId,
        tx_script: &TransactionScript,
        advice_inputs: &AdviceInputs,
        foreign_accounts: ForeignAccountArray,
    ) -> Result<FeltArray, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let foreign_accounts_vec: Vec<crate::models::foreign_account::ForeignAccount> =
            foreign_accounts.into();
        let foreign_accounts_map: BTreeMap<NativeAccountId, NativeForeignAccount> =
            foreign_accounts_vec
                .into_iter()
                .map(|a| {
                    let fa: NativeForeignAccount = a.into();
                    (fa.account_id(), fa)
                })
                .collect();

        let result = client
            .execute_program(
                account_id.into(),
                tx_script.into(),
                advice_inputs.into(),
                foreign_accounts_map,
            )
            .await
            .map_err(|err| js_error_with_context(err, "failed to execute program"))?;

        let felt_vec: Vec<Felt> = result.iter().map(|f| Felt::from(*f)).collect();
        Ok(felt_vec.into())
    }

    /// Generates a transaction proof using either the provided prover or the client's default
    /// prover if none is supplied.
    ///
    /// With an explicit prover this is a pure computation over the `TransactionResult` and does
    /// not touch client state, so it works on a bare `WebClient` that never ran
    /// `createClient()`. "Prover-only" hosts rely on this — e.g. a `chrome.offscreen` document
    /// that proves on its own rayon thread pool. Only the default-prover fallback requires an
    /// initialized client.
    #[js_export(js_name = "proveTransaction")]
    pub async fn prove_transaction(
        &self,
        transaction_result: &TransactionResult,
        prover: Option<TransactionProver>,
    ) -> Result<ProvenTransaction, JsErr> {
        #[cfg(feature = "testing")]
        if prover.is_none() && self.mock_rpc_api.lock().await.is_some() {
            return LocalTransactionProver::default()
                .prove_dummy(transaction_result.native().executed_transaction().clone())
                .map(Into::into)
                .map_err(|err| js_error_with_context(err, "failed to prove transaction"));
        }

        // Resolve the prover up front and release the inner-client lock before the
        // (potentially multi-second) prove: the proof itself needs no client state, so other
        // client calls must not block on it.
        let prover_arc = if let Some(custom_prover) = prover {
            custom_prover.get_prover()
        } else {
            let mut guard = self.get_mut_inner().await;
            let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
            client.prover()
        };

        let executed_transaction = transaction_result.native().executed_transaction().clone();
        let fut = Box::pin(async move { prover_arc.prove(executed_transaction.into()).await });
        maybe_wrap_send(fut)
            .await
            .map(Into::into)
            .map_err(|err| js_error_with_context(err, "failed to prove transaction"))
    }

    #[js_export(js_name = "submitProvenTransaction")]
    pub async fn submit_proven_transaction(
        &self,
        proven_transaction: &ProvenTransaction,
        transaction_result: &TransactionResult,
    ) -> Result<u32, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let native_proven: NativeProvenTransaction = proven_transaction.clone().into();
        client
            .submit_proven_transaction(native_proven, transaction_result.native())
            .await
            .map(|block_number| block_number.as_u32())
            .map_err(|err| js_error_with_context(err, "failed to submit proven transaction"))
    }

    #[js_export(js_name = "applyTransaction")]
    pub async fn apply_transaction(
        &self,
        transaction_result: &TransactionResult,
        submission_height: u32,
    ) -> Result<TransactionStoreUpdate, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let fut = Box::pin(client.get_transaction_store_update(
            transaction_result.native(),
            BlockNumber::from(submission_height),
        ));
        let update = maybe_wrap_send(fut)
            .await
            .map(TransactionStoreUpdate::from)
            .map_err(|err| js_error_with_context(err, "failed to build transaction update"))?;

        let native_update: NativeTransactionStoreUpdate = (&update).into();
        let fut = Box::pin(client.apply_transaction_update(native_update));
        maybe_wrap_send(fut)
            .await
            .map_err(|err| js_error_with_context(err, "failed to apply transaction result"))?;

        Ok(update)
    }

    #[js_export(js_name = "newConsumeTransactionRequest")]
    pub fn new_consume_transaction_request(
        &self,
        list_of_notes: Vec<Note>,
    ) -> Result<TransactionRequest, JsErr> {
        let consume_transaction_request = {
            let native_notes = list_of_notes
                .into_iter()
                .map(NativeNote::try_from)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| {
                    from_str_err(&format!("Failed to convert note to native note: {err}"))
                })?;

            NativeTransactionRequestBuilder::new()
                .build_consume_notes(native_notes)
                .map_err(|err| {
                    from_str_err(&format!("Failed to create Consume Transaction Request: {err}"))
                })?
        };

        Ok(consume_transaction_request.into())
    }
}
