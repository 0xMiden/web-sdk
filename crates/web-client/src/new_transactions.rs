use alloc::collections::BTreeMap;

use js_export_macro::js_export;
use miden_client::account::component::FeeConversionInfo as NativeFeeConversionInfo;
use miden_client::account::{AccountComponentInterfaceExt, AccountId as NativeAccountId};
use miden_client::agglayer::B2AggNote;
use miden_client::asset::{AssetAmount, FungibleAsset};
use miden_client::crypto::FeltRng;
use miden_client::note::{
    BlockNumber,
    Note as NativeNote,
    NoteAssets as NativeNoteAssets,
    PswapNote,
};
#[cfg(feature = "testing")]
use miden_client::transaction::LocalTransactionProver;
use miden_client::transaction::{
    AccountComponentInterface,
    ChainAnchorError,
    ForeignAccount as NativeForeignAccount,
    PaymentNoteDescription,
    ProvenTransaction as NativeProvenTransaction,
    PswapTransactionData,
    SwapTransactionData,
    TransactionExecutorError,
    TransactionRequest as NativeTransactionRequest,
    TransactionRequestBuilder as NativeTransactionRequestBuilder,
};
use miden_client::{Client, ClientError, Word as NativeWord};

use crate::models::NoteType;
use crate::models::account_id::AccountId;
use crate::models::advice_inputs::AdviceInputs;
use crate::models::chain_anchor::ChainAnchor;
use crate::models::eth_address::EthAddress;
use crate::models::felt::Felt;
use crate::models::miden_arrays::{FeltArray, ForeignAccountArray};
use crate::models::note::Note;
use crate::models::proven_transaction::ProvenTransaction;
use crate::models::provers::TransactionProver;
use crate::models::transaction_id::TransactionId;
use crate::models::transaction_request::TransactionRequest;
use crate::models::transaction_request::transaction_request_builder::TransactionRequestBuilder;
use crate::models::transaction_result::TransactionResult;
use crate::models::transaction_script::TransactionScript;
use crate::models::transaction_store_update::TransactionStoreUpdate;
use crate::models::transaction_summary::TransactionSummary;
use crate::platform::{
    JsBytes,
    JsErr,
    from_str_err,
    from_str_err_with_code,
    js_u64_to_u64,
    maybe_wrap_send,
};
use crate::utils::deserialize_from_bytes;
use crate::{WebClient, js_error_with_context};

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

            // The faucet executes a mint, so it is the account whose auth procedure reads the
            // conversion info.
            let builder = fee_aware_builder(client, faucet_id.into()).await?;
            builder
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

        let builder = fee_aware_builder(client, sender_account_id.into()).await?;
        let send_transaction_request = builder
            .build_pay_to_id(payment_description, note_type.into(), client.rng())
            .map_err(|err| {
                js_error_with_context(err, "failed to create send transaction request")
            })?;

        Ok(send_transaction_request.into())
    }

    /// Builds a transaction request that bridges a fungible asset out to another network via the
    /// `AggLayer`.
    ///
    /// The request emits a single public B2AGG (Bridge-to-AggLayer) note holding `amount` units of
    /// the `faucet_id` asset. The note is consumed by `bridge_account_id`, which burns the asset so
    /// it can be claimed at `destination_address` (an Ethereum address) on the AggLayer-assigned
    /// `destination_network`.
    #[js_export(js_name = "newB2AggTransactionRequest")]
    #[allow(clippy::too_many_arguments)]
    pub async fn new_b2agg_transaction_request(
        &self,
        sender_account_id: &AccountId,
        bridge_account_id: &AccountId,
        faucet_id: &AccountId,
        amount: JsU64,
        destination_network: u32,
        destination_address: &EthAddress,
    ) -> Result<TransactionRequest, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| {
            from_str_err("Client not initialized while generating transaction request")
        })?;

        let amount = js_u64_to_u64(amount);
        let fungible_asset = FungibleAsset::new(faucet_id.into(), amount)
            .map_err(|err| js_error_with_context(err, "failed to create fungible asset"))?;
        let note_assets = NativeNoteAssets::new(vec![fungible_asset.into()])
            .map_err(|err| js_error_with_context(err, "failed to create b2agg note assets"))?;

        let b2agg_note = B2AggNote::create(
            destination_network,
            destination_address.into(),
            note_assets,
            bridge_account_id.into(),
            sender_account_id.into(),
            client.rng(),
        )
        .map_err(|err| js_error_with_context(err, "failed to create b2agg note"))?;

        let builder = fee_aware_builder(client, sender_account_id.into()).await?;
        let b2agg_transaction_request =
            builder.own_output_notes(vec![b2agg_note]).build().map_err(|err| {
                js_error_with_context(err, "failed to create b2agg transaction request")
            })?;

        Ok(b2agg_transaction_request.into())
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

            let builder = fee_aware_builder(client, sender_account_id.into()).await?;
            builder
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

            let builder = fee_aware_builder(client, creator_account_id.into()).await?;
            builder
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
    pub async fn new_pswap_consume_transaction_request(
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

        let pswap_transaction_request = {
            let mut guard = self.get_mut_inner().await;
            let client = guard.as_mut().ok_or_else(|| {
                from_str_err("Client not initialized while generating transaction request")
            })?;

            // The consumer executes the fill, so it is the account whose auth procedure reads
            // the conversion info.
            let builder = fee_aware_builder(client, consumer_account_id.into()).await?;
            builder
                .build_pswap_consume(
                    &native_pswap_note,
                    consumer_account_id.into(),
                    account_fill_amount,
                    note_fill_amount,
                )
                .map_err(|err| {
                    js_error_with_context(err, "failed to create PSWAP consume transaction request")
                })?
        };

        Ok(pswap_transaction_request.into())
    }

    #[js_export(js_name = "newPswapCancelTransactionRequest")]
    pub async fn new_pswap_cancel_transaction_request(
        &self,
        pswap_note: &Note,
        creator_account_id: &AccountId,
    ) -> Result<TransactionRequest, JsErr> {
        let native_pswap_note: NativeNote = pswap_note.into();

        let pswap_transaction_request = {
            let mut guard = self.get_mut_inner().await;
            let client = guard.as_mut().ok_or_else(|| {
                from_str_err("Client not initialized while generating transaction request")
            })?;

            // The creator executes the cancellation, so it is the account whose auth procedure
            // reads the conversion info.
            let builder = fee_aware_builder(client, creator_account_id.into()).await?;
            builder
                .build_pswap_cancel(native_pswap_note, creator_account_id.into())
                .map_err(|err| {
                    js_error_with_context(err, "failed to create PSWAP cancel transaction request")
                })?
        };

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

    /// Executes a batch of transactions against the specified account, proves them individually
    /// and as a batch, submits the batch to the network, and atomically applies the per-tx
    /// updates to the local store. Returns the block number the batch was accepted into.
    ///
    /// All transactions must target the same local account — the `account_id` argument.
    /// Each element of `transaction_requests` is the serialized-bytes form of a
    /// `TransactionRequest` (obtained via `tx_request.serialize()`)
    // TODO V2: support multi-account batches
    #[js_export(js_name = "submitNewTransactionBatch")]
    pub async fn submit_new_transaction_batch(
        &self,
        account_id: &AccountId,
        transaction_requests: Vec<JsBytes>,
    ) -> Result<u32, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let native_account_id: miden_client::account::AccountId = account_id.into();

        // Deserialize all requests up front so we fail early on malformed input.
        let mut native_reqs: Vec<NativeTransactionRequest> =
            Vec::with_capacity(transaction_requests.len());
        for bytes in &transaction_requests {
            let req = deserialize_from_bytes::<NativeTransactionRequest>(bytes).map_err(|err| {
                from_str_err(&format!("failed to deserialize transaction request: {err:?}"))
            })?;
            native_reqs.push(req);
        }

        // Vet every request before the builder exists. `push` proves each transaction as it goes,
        // so a rejection discovered mid-push would already have cost the proofs of everything
        // ahead of it.
        //
        // The auth-argument check is request-local. The account classification is not, and the
        // batch is single-account by contract, so it is read at most once for the whole batch
        // rather than once per request.
        let mut any_declares_fee_conversion_info = false;
        for native_req in &native_reqs {
            // Unconditional, for the reason spelled out in
            // `ensure_fee_conversion_info_classifiable`: a request whose commitment was
            // replaced reports `declares_fee_conversion_info() == false`,
            // so gating this on that flag skips the request that most needs it.
            ensure_fee_conversion_info_auth_arg_intact(native_req)?;
            any_declares_fee_conversion_info |= native_req.declares_fee_conversion_info();
        }
        if any_declares_fee_conversion_info {
            ensure_batch_fee_conversion_info_supported(client, native_account_id).await?;
        }

        // `new_transaction_batch()` is now a synchronous builder constructor that takes no
        // account id; the target account is supplied per-transaction via `push`. This wrapper
        // keeps its single-account contract by pushing every request against `native_account_id`.
        let mut builder = client.new_transaction_batch();

        for native_req in native_reqs {
            maybe_wrap_send(Box::pin(builder.push(native_account_id, native_req)))
                .await
                .map_err(|err| js_error_with_context(err, "failed to push transaction to batch"))?;
        }

        maybe_wrap_send(Box::pin(builder.submit()))
            .await
            .map(|block_number| block_number.as_u32())
            .map_err(|err| js_error_with_context(err, "failed to submit transaction batch"))
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
        let native_request: NativeTransactionRequest = transaction_request.into();
        ensure_fee_conversion_info_classifiable(client, account_id.into(), &native_request).await?;
        let fut = Box::pin(client.execute_transaction(account_id.into(), native_request));
        maybe_wrap_send(fut)
            .await
            .map(TransactionResult::from)
            .map_err(|err| js_error_with_context(err, "failed to execute transaction"))
    }

    /// Captures a [`ChainAnchor`] at the client's current sync height, tracking the creation
    /// blocks of the request's authenticated input notes so the request can later execute
    /// against the anchor.
    ///
    /// This is the capture entry point for flows that never see a successful execution at capture
    /// time — e.g. a multisig proposal, where execution intentionally fails with the unauthorized
    /// event to surface the summary for signing. Capture the anchor first, derive the summary
    /// with `executeForSummaryAt`, and ship the anchor alongside the signed data; the same anchor
    /// then reproduces the summary during later verification and execution.
    ///
    /// # Errors
    ///
    /// Fails with code `INVALID_CHAIN_ANCHOR` if the captured block header and blockchain peaks
    /// are inconsistent, which happens when a sync lands mid-capture. Retrying is the fix.
    #[js_export(js_name = "chainAnchorForRequest")]
    pub async fn chain_anchor_for_request(
        &self,
        transaction_request: &TransactionRequest,
    ) -> Result<ChainAnchor, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;

        let native_request: NativeTransactionRequest = transaction_request.into();
        let fut = Box::pin(client.chain_anchor_for_request(&native_request));
        maybe_wrap_send(fut)
            .await
            .map(ChainAnchor::from)
            .map_err(|err| map_anchor_err(err, "failed to capture chain anchor"))
    }

    /// Executes a transaction against the specified account using `anchor` as the reference block
    /// instead of the current sync height, without submitting it or updating the local database.
    ///
    /// Since protocol 0.16 the signed transaction summary binds the reference block commitment, so
    /// signatures collected over a summary only authorize an execution whose reference block is
    /// the one the summary was built at. This method makes such an execution reproducible on any
    /// client regardless of its sync height.
    ///
    /// Callers holding an anchor from an untrusted source should first compare
    /// `anchor.commitment()` against an independently trusted value, e.g. the block commitment
    /// bound into the signed transaction summary.
    ///
    /// # Errors
    /// - If an authenticated input note's creation block is not tracked by the anchor.
    /// - If an input note was created after the anchored reference block.
    #[js_export(js_name = "executeTransactionAt")]
    pub async fn execute_transaction_at(
        &self,
        account_id: &AccountId,
        transaction_request: &TransactionRequest,
        anchor: &ChainAnchor,
    ) -> Result<TransactionResult, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let native_request: NativeTransactionRequest = transaction_request.into();
        ensure_fee_conversion_info_classifiable(client, account_id.into(), &native_request).await?;
        let fut = Box::pin(client.execute_transaction_at(
            account_id.into(),
            native_request,
            anchor.into(),
        ));
        maybe_wrap_send(fut)
            .await
            .map(TransactionResult::from)
            .map_err(|err| map_anchor_err(err, "failed to execute transaction at anchor"))
    }

    /// Executes a transaction at `anchor` and returns the `TransactionSummary` the account is
    /// being asked to authorize — the anchored counterpart of `executeForSummary`.
    ///
    /// This is what lets a co-signer verify a proposal: re-deriving the summary at the proposer's
    /// anchor reproduces it exactly, so it can be compared against the summary they were asked to
    /// sign. Deriving it at the local sync height instead would produce a different summary and
    /// the comparison would always fail.
    ///
    /// # Errors
    /// - If the transaction executes successfully (error code `TRANSACTION_ALREADY_AUTHORIZED`).
    /// - If there is an internal failure during execution.
    #[js_export(js_name = "executeForSummaryAt")]
    pub async fn execute_for_summary_at(
        &self,
        account_id: &AccountId,
        transaction_request: &TransactionRequest,
        anchor: &ChainAnchor,
    ) -> Result<TransactionSummary, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;

        let native_request: NativeTransactionRequest = transaction_request.into();
        ensure_fee_conversion_info_classifiable(client, account_id.into(), &native_request).await?;
        let fut = Box::pin(client.execute_transaction_at(
            account_id.into(),
            native_request,
            anchor.into(),
        ));
        match maybe_wrap_send(fut).await {
            Ok(_) => Err(from_str_err_with_code(
                "transaction is already fully authorized, so no transaction summary was \
                 produced during execution; submit it with executeTransactionAt against the \
                 same anchor instead",
                "TRANSACTION_ALREADY_AUTHORIZED",
            )),
            Err(ClientError::TransactionExecutorError(TransactionExecutorError::Unauthorized(
                summary,
            ))) => Ok(TransactionSummary::from(*summary)),
            Err(err) => Err(map_anchor_err(err, "failed to execute transaction at anchor")),
        }
    }

    /// Executes a transaction and returns the `TransactionSummary` the account is being asked
    /// to authorize.
    ///
    /// The summary only exists while authorization is pending: when the auth procedure aborts
    /// with the unauthorized event (e.g. a multisig below its signing threshold), the summary
    /// built during execution is returned so it can be signed out-of-band. If the transaction
    /// executes successfully it was already fully authorized, no summary is produced, and this
    /// method returns an error with code `TRANSACTION_ALREADY_AUTHORIZED` — submit the
    /// transaction with `execute` instead.
    ///
    /// # Errors
    /// - If the transaction executes successfully (error code `TRANSACTION_ALREADY_AUTHORIZED`).
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
        ensure_fee_conversion_info_classifiable(client, account_id.into(), &native_request).await?;
        let fut = Box::pin(client.execute_transaction(account_id.into(), native_request));
        match maybe_wrap_send(fut).await {
            Ok(_) => Err(from_str_err_with_code(
                "transaction is already fully authorized, so no transaction summary was \
                 produced during execution; submit it with execute instead",
                "TRANSACTION_ALREADY_AUTHORIZED",
            )),
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

    /// Persists a submitted transaction and returns its pre-apply
    /// [`TransactionStoreUpdate`]. Routes through the high-level
    /// `Client::apply_transaction` so registered observers (e.g. PSWAP
    /// tracking) fire.
    #[js_export(js_name = "applyTransaction")]
    pub async fn apply_transaction(
        &self,
        transaction_result: &TransactionResult,
        submission_height: u32,
    ) -> Result<TransactionStoreUpdate, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;
        let height = BlockNumber::from(submission_height);

        // Build the pre-apply update for the JS return value.
        let fut =
            Box::pin(client.get_transaction_store_update(transaction_result.native(), height));
        let update = maybe_wrap_send(fut)
            .await
            .map(TransactionStoreUpdate::from)
            .map_err(|err| js_error_with_context(err, "failed to build transaction update"))?;

        // High-level apply fires registered observers (e.g. PSWAP tracking);
        // the low-level `apply_transaction_update` would persist without them.
        let fut = Box::pin(client.apply_transaction(transaction_result.native(), height));
        maybe_wrap_send(fut)
            .await
            .map_err(|err| js_error_with_context(err, "failed to apply transaction result"))?;

        Ok(update)
    }

    /// Builds a request consuming `list_of_notes`, to be executed by `consuming_account_id`.
    ///
    /// The account is required because it is what decides whether the chain's fee conversion info
    /// is committed to the request's auth args. Committing it to a request destined for an account
    /// whose auth procedure does not read it — a no-auth or network account — makes miden-client
    /// reject the request before execution, so there is no default that is right for every caller.
    #[js_export(js_name = "newConsumeTransactionRequest")]
    pub async fn new_consume_transaction_request(
        &self,
        list_of_notes: Vec<Note>,
        consuming_account_id: &AccountId,
    ) -> Result<TransactionRequest, JsErr> {
        // Async only so the chain's fee parameters can be read; the request itself is built the
        // same way it always was. A consume is the one transaction an empty account can afford,
        // because the note's credit lands in the vault before `pay_fee` withdraws from it -- but
        // only if the conversion info is committed, or it never reaches the fee at all.
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| {
            from_str_err("Client not initialized while generating consume transaction request")
        })?;

        let consume_transaction_request = {
            let native_notes = list_of_notes
                .into_iter()
                .map(NativeNote::try_from)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| {
                    from_str_err(&format!("Failed to convert note to native note: {err}"))
                })?;

            let builder = fee_aware_builder(client, consuming_account_id.into()).await?;
            builder.build_consume_notes(native_notes).map_err(|err| {
                from_str_err(&format!("Failed to create Consume Transaction Request: {err}"))
            })?
        };

        Ok(consume_transaction_request.into())
    }

    /// A `TransactionRequestBuilder` already carrying this chain's fee conversion info, for
    /// `account_id` to execute.
    ///
    /// Use this instead of `new TransactionRequestBuilder()` whenever the request is assembled by
    /// the caller rather than by one of the convenience constructors. Since protocol 0.16 the fee
    /// is paid inside the account's auth procedure and `fee::pay_fee` reads the conversion info
    /// from the transaction's auth args, so a request built from a bare builder aborts with
    /// `ERR_FEE_CONVERSION_INFO_MISSING` on any chain whose verification base fee is non-zero.
    ///
    /// The returned builder is otherwise empty and carries no auth arg on a zero-fee chain or for
    /// an account whose auth procedure cannot read conversion info, so it is a safe drop-in. Note
    /// that it sets the auth arg where it does apply: calling `withAuthArg` on the result
    /// overwrites the commitment, and `build` then refuses it with error code
    /// `FEE_CONVERSION_INFO_AUTH_ARG_OVERWRITTEN`.
    #[js_export(js_name = "feeAwareTransactionRequestBuilder")]
    pub async fn fee_aware_transaction_request_builder(
        &self,
        account_id: &AccountId,
    ) -> Result<TransactionRequestBuilder, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| {
            from_str_err("Client not initialized while creating a transaction request builder")
        })?;

        let (builder, declares_fee_conversion_info) =
            fee_aware_builder_and_declaration(client, account_id.into()).await?;
        Ok(TransactionRequestBuilder::from_native(builder, declares_fee_conversion_info))
    }
}

/// Maps an anchor-path failure to a JS error, tagging every anchor rejection with a
/// machine-readable code so callers can tell one apart from a generic execution failure.
///
/// Two kinds reach this. A capture-time inconsistency: the anchor is assembled from three separate
/// store reads (sync height, that block's header, the current blockchain peaks) and validated for
/// mutual consistency, so a sync landing from another tab mid-capture yields an anchor whose parts
/// disagree. Retrying the capture is the fix, and saying so is worth doing because nothing in the
/// upstream message does.
///
/// The rest are execution-time rejections of an anchor that is internally consistent — a block the
/// anchor does not track, a reference block that does not match it, an anchor tracking more blocks
/// than a transaction may reference, or an anchored transaction the chain has already expired past.
/// Each already names its own remedy in the upstream message, and for them re-capturing unchanged
/// would loop, so the sync-race hint is deliberately not appended.
fn map_anchor_err(err: ClientError, context: &'static str) -> JsErr {
    match err {
        ClientError::ChainAnchorError(anchor_err) => {
            // Only the two mutual-consistency checks can be lost to a concurrent sync; every other
            // variant describes a property of the anchor that retrying will reproduce.
            let lost_to_concurrent_sync = matches!(
                anchor_err,
                ChainAnchorError::ChainLengthMismatch { .. }
                    | ChainAnchorError::ChainCommitmentMismatch { .. }
            );
            let message = if lost_to_concurrent_sync {
                format!(
                    "{context}: {anchor_err}; a sync may have landed during capture, so retrying \
                     is usually the fix"
                )
            } else {
                format!("{context}: {anchor_err}")
            };
            from_str_err_with_code(&message, "INVALID_CHAIN_ANCHOR")
        },
        err => js_error_with_context(err, context),
    }
}

// FEE CONVERSION INFO
// ================================================================================================

/// The standard auth components installed on `account_id`, or `None` when the account is not in
/// the store.
///
/// An empty vector means the account's auth procedure is one this crate cannot name: either
/// genuinely custom, or standard but compiled from a different miden-standards revision.
///
/// Classification reads the account's code only, and deliberately avoids `AccountInterface`:
/// building one asserts that exactly one auth component is present, and an account carrying a
/// custom auth procedure classifies as `Custom` rather than any auth variant, so the assertion
/// fires. `wasm32` is `panic = "abort"`, which makes that a trap taken while the client borrow is
/// held — poisoning the client for every later call. `from_procedures` cannot panic.
///
/// Matching is by MAST procedure root against the locally pinned miden-standards, so an account
/// whose auth component was compiled from a different revision classifies as `Custom` and yields
/// an empty vector even though its procedure is a standard one. Nothing here can tell that case
/// apart from a genuinely custom auth procedure, so it is a reason to keep this crate's
/// miden-standards pin aligned with the networks it targets rather than something to detect.
async fn standard_auth_components(
    client: &Client<crate::ClientAuth>,
    account_id: NativeAccountId,
) -> Result<Option<Vec<AccountComponentInterface>>, JsErr> {
    let Some(code) = client.get_account_code(account_id).await.map_err(|err| {
        js_error_with_context(
            err,
            &format!(
                "failed to read the code of account {account_id} to classify its auth component"
            ),
        )
    })?
    else {
        return Ok(None);
    };

    Ok(Some(
        AccountComponentInterface::from_procedures(code.procedures())
            .into_iter()
            .filter(|component| {
                matches!(
                    component,
                    AccountComponentInterface::AuthSingleSig
                        | AccountComponentInterface::AuthMultisig
                        | AccountComponentInterface::AuthMultisigSmart
                        | AccountComponentInterface::AuthGuardedMultisig
                        | AccountComponentInterface::AuthNoAuth
                        | AccountComponentInterface::AuthNetworkAccount
                )
            })
            .collect(),
    ))
}

/// Whether `account_id`'s auth procedure reads fee conversion info from the transaction's auth
/// args, and therefore whether committing any is useful to it.
///
/// `AuthSingleSig`, `AuthMultisig` and `AuthGuardedMultisig` do — all three call
/// `fee::load_conversion_info` from their auth procedure. `AuthNoAuth` and `AuthNetworkAccount`
/// discard `AUTH_ARGS` and call `fee::native_conversion_info` instead, so they pay the fee natively
/// and need nothing committed. `AuthMultisigSmart` never reaches `miden::standards::fee` at all and
/// reinterprets the word as a transaction summary salt, so committing conversion info to it would
/// be read as something else entirely.
///
/// This set has to mirror miden-client's exactly, and the two must move together in both
/// directions. `validate_fee_conversion_info_support` *rejects* a request declaring conversion info
/// against an account outside upstream's allowlist, so attaching it too widely turns a working
/// transaction into a rejected one — and for the two multisig variants
/// `resolve_fee_conversion_info` *requires* it, returning
/// `TransactionRequestError::FeeConversionInfoRequired` when a request declares none on a
/// fee-charging chain, so attaching it too narrowly is equally fatal. Only `AuthSingleSig` has
/// conversion info injected upstream when a request declares none.
///
/// Answers `false` for an auth procedure this crate cannot name, and for an account carrying more
/// than one standard auth component: declaring conversion info would hand upstream's check an
/// account it also cannot classify, which it rejects. Such an account has to commit its own
/// commitment through `TransactionRequest.withAuthArg`, which carries no declaration for upstream
/// to validate.
///
/// Takes the permissive branch when the account is not in the store, so that the account-not-found
/// error surfaces on its own rather than being preempted by a fee decision made about an account
/// nothing knows anything about. That is the wrong answer for an account tracked only by whoever
/// the request is serialized to, but a request built against an untracked account cannot be
/// executed locally, and the alternative — declaring nothing — is equally wrong for the multisig
/// case that transport flow exists to serve.
async fn reads_fee_conversion_info(
    client: &Client<crate::ClientAuth>,
    account_id: NativeAccountId,
) -> Result<bool, JsErr> {
    let Some(components) = standard_auth_components(client, account_id).await? else {
        return Ok(true);
    };

    // Exactly one, mirroring `auth_component_of`: it matches `(Some, None)` over the filtered
    // components and yields `None` for anything else, so two standard auth components are as
    // unclassifiable upstream as zero are. Answering `true` on `any` would attach conversion info
    // to a request that `ensure_fee_conversion_info_classifiable` then refuses to execute.
    let [component] = components.as_slice() else {
        return Ok(false);
    };

    Ok(matches!(
        component,
        AccountComponentInterface::AuthSingleSig
            | AccountComponentInterface::AuthMultisig
            | AccountComponentInterface::AuthGuardedMultisig
    ))
}

/// Whether an auth procedure built from `components` pays the fee from the chain's native fee
/// asset and discards the transaction's auth arguments entirely.
///
/// `AuthNoAuth` and `AuthNetworkAccount` are the two that do: both call
/// `fee::native_conversion_info` rather than `fee::load_conversion_info`. For them any declared
/// conversion info has no effect at all.
///
/// Deliberately not the negation of `reads_fee_conversion_info`. The components in neither set —
/// `AuthMultisigSmart`, and anything this crate cannot name — neither read conversion info under
/// upstream's allowlist *nor* pay natively, so nothing can be concluded about them and they answer
/// `false` here.
///
/// Takes the components rather than reading them, so a caller that already needs them for another
/// question pays for one account-code read instead of two.
fn pays_fee_natively(components: &[AccountComponentInterface]) -> bool {
    components.iter().any(|component| {
        matches!(
            component,
            AccountComponentInterface::AuthNoAuth | AccountComponentInterface::AuthNetworkAccount
        )
    })
}

/// Refuses a request whose fee-conversion commitment no longer matches its advice map.
///
/// The caller must already have established that the request declares fee conversion info; this
/// looks only at the auth arg and the advice map, so on a request that does not declare any it
/// would refuse a plain `withAuthArg` and blame a collision that never happened.
///
/// This catches the *request*-level overwrite: `TransactionRequest.withAuthArg` replaces the auth
/// arg on an already-built request and, unlike the builder's method, leaves its fee-conversion
/// declaration standing. The commitment is gone but the preimage is still keyed by it, so
/// `fee::load_conversion_info` looks up the *current* auth arg, finds nothing, and `pay_fee` aborts
/// with `ERR_FEE_CONVERSION_INFO_MISSING` deep in the VM — a message naming neither the collision
/// nor the methods involved.
///
/// The builder's own `withAuthArg` cannot reach this: it clears the native declaration, so a
/// request built that way arrives here declaring nothing. That collision is refused earlier, by
/// `TransactionRequestBuilder::build`, with the same error code.
///
/// The detection is a presence test, not a recomputation: upstream's `fee_conversion_info` attaches
/// the preimage keyed by the auth arg it just set, so a declared request whose auth arg has no
/// advice entry had that arg replaced afterwards.
///
/// That makes it defeatable, deliberately: pointing the auth arg at some *other* key that already
/// holds a value — a signature blob, a note payload, an orphaned preimage from an earlier
/// `withFeeConversionInfo` — passes this check. Nothing is mispaid as a result.
/// `load_conversion_info` asserts `poseidon2::merge` of the advice value against `AUTH_ARGS` and
/// aborts with `ERR_FEE_CONVERSION_INFO_COMMITMENT_MISMATCH`, so short of a hash collision the VM
/// still refuses it; only the named early error is lost. Recomputing the hash here would close
/// that, at the cost of duplicating the commitment scheme in a second place — not worth it while
/// the VM's check is the authority.
///
/// Refuses regardless of the chain's base fee. On a zero-fee chain the combination would in fact
/// execute — `pay_fee` requires the conversion info only when the fee is non-zero — but a request
/// that declares conversion info and cannot honour it is a mistake worth surfacing at the
/// development height rather than on the first chain that charges.
///
/// Checked at the execution and submission entry points rather than in the builder because the
/// advice map can legitimately be extended after the request is built — the multisig flow attaches
/// collected signatures that way — so only here is the map final. Every path that hands a request
/// to the kernel checks it: a replaced auth arg that slips through aborts deep inside execution
/// with a kernel error instead of being refused by name.
fn ensure_fee_conversion_info_auth_arg_intact(
    request: &NativeTransactionRequest,
) -> Result<(), JsErr> {
    if let Some(commitment) = request.auth_arg()
        && request.advice_map().get(commitment).is_none()
    {
        return Err(from_str_err_with_code(
            "this request carries an auth argument with no preimage in its advice map. An auth \
             argument is a commitment and the kernel reads it back through that preimage, so a \
             commitment with none aborts in the VM with ERR_FEE_CONVERSION_INFO_MISSING. Calling \
             `TransactionRequest.withAuthArg` on a request that committed fee conversion info \
             does exactly that: it replaces the commitment and leaves the preimage keyed by the \
             old one. The two are mutually exclusive — attach a self-computed commitment together \
             with its preimage, or build one request per auth argument.",
            "FEE_CONVERSION_INFO_AUTH_ARG_OVERWRITTEN",
        ));
    }

    Ok(())
}

/// Refuses a batch whose declared fee conversion info the executing account cannot honour.
///
/// Batch execution never runs `validate_account_request`: `BatchBuilder::push` goes straight to
/// `prepare_transaction`, which has only the in-batch `PartialAccount` and deliberately skips the
/// checks that need a full `Account`. Upstream compensates by calling
/// `validate_fee_conversion_info_support` from `resolve_fee_conversion_info` inside
/// `prepare_transaction`, so the batch is not unguarded — it would be rejected there rather than
/// mispaid. What this adds is *when* and *how legibly*: `push` proves each transaction as it goes,
/// so a rejection discovered mid-push has already cost the proofs of everything ahead of it, and
/// upstream's own rejection carries no machine-readable code.
///
/// Raises the same two codes the single-transaction path does, so a caller branching on them does
/// not have to special-case batches:
///
/// - `FEE_CONVERSION_INFO_IGNORED` for the two components that provably discard `AUTH_ARGS` and pay
///   from the chain's native fee asset (`AuthNoAuth`, `AuthNetworkAccount`, both of which call
///   `fee::native_conversion_info`). For those, and only those, the declaration demonstrably has no
///   effect. Deliberately narrower than upstream's allowlist: `AuthMultisigSmart` and custom auth
///   procedures do not pay natively, so for them nothing is being ignored.
/// - `FEE_CONVERSION_INFO_UNCLASSIFIABLE` when the account carries anything other than exactly one
///   standard auth component, mirroring `auth_component_of`.
///
/// The batch is single-account by contract, so the account's code is read once here rather than
/// once per request.
async fn ensure_batch_fee_conversion_info_supported(
    client: &Client<crate::ClientAuth>,
    account_id: NativeAccountId,
) -> Result<(), JsErr> {
    let Some(components) = standard_auth_components(client, account_id).await? else {
        // Not in the store: let upstream's account-not-found error surface on its own rather than
        // pre-empting it with a fee decision about an account nothing knows anything about.
        return Ok(());
    };

    // Cardinality first, matching `auth_component_of`: an account carrying several standard auth
    // components is one upstream can name no single component for, so "unclassifiable" is what is
    // actually true of it. Asking `pays_fee_natively` first would answer `IGNORED` for an account
    // that merely *contains* a native-paying component alongside others, which is a stronger claim
    // than the components support.
    if components.len() != 1 {
        return Err(fee_conversion_info_unclassifiable_err(components.len()));
    }

    if pays_fee_natively(&components) {
        return Err(fee_conversion_info_ignored_err());
    }

    Ok(())
}

/// The `FEE_CONVERSION_INFO_IGNORED` rejection, for an account whose auth procedure pays the fee
/// from the chain's native fee asset and discards the transaction's auth arguments.
///
/// Shared by the single-transaction and batch preflights, and worded for both: a caller branching
/// on the code should get the same explanation wherever the request was submitted.
fn fee_conversion_info_ignored_err() -> JsErr {
    from_str_err_with_code(
        "this request declares fee conversion info, but the executing account's auth procedure \
         pays the fee from the chain's native fee asset and discards the transaction's auth \
         arguments, so the declared asset and rate would have no effect. Build the request \
         without fee conversion info, or execute it against an account whose auth procedure \
         reads it.",
        "FEE_CONVERSION_INFO_IGNORED",
    )
}

/// The `FEE_CONVERSION_INFO_UNCLASSIFIABLE` rejection, for an account carrying `component_count`
/// standard auth components rather than the exactly one `auth_component_of` can name.
///
/// Shared by the single-transaction and batch preflights so both paths report the case
/// identically; a caller branching on the code should not have to tell them apart.
///
/// Names both escape hatches, because which one applies depends on a procedure this crate cannot
/// see. An auth procedure that reads `AUTH_ARGS` needs the commitment attached without the
/// declaration upstream would try to validate, which is `TransactionRequest.withAuthArg` plus
/// `extendAdviceMap`; one that has not been written yet is better off reading the chain's native
/// conversion info directly and needing no auth argument at all.
fn fee_conversion_info_unclassifiable_err(component_count: usize) -> JsErr {
    from_str_err_with_code(
        &format!(
            "this request declares fee conversion info, but the account carries \
             {component_count} standard auth components rather than exactly one, and miden-client \
             can only validate fee conversion info against an account with a single standard auth \
             component. Build the request without `withFeeConversionInfo`, then either attach a \
             self-computed commitment with `TransactionRequest.withAuthArg` plus \
             `extendAdviceMap` — which carries no declaration for miden-client to validate — or, \
             if the auth procedure is yours to write, have it read the chain's native fee \
             conversion info instead of the transaction's auth arguments."
        ),
        "FEE_CONVERSION_INFO_UNCLASSIFIABLE",
    )
}

/// Refuses a request that declares fee conversion info against an account carrying a custom auth
/// procedure, before the request reaches miden-client.
///
/// miden-client rejects this case too, but namelessly and without a code:
/// `validate_fee_conversion_info_support` asks `auth_component_of` for the account's single
/// recognized auth component, and when the component set does not name exactly one it reports
/// `FeeConversionInfoUnsupported("set (no single recognized auth component)")` — a string that
/// names neither the account's actual component nor a way forward. Raising
/// `FEE_CONVERSION_INFO_UNCLASSIFIABLE` first is what gives the case a stable machine-readable code
/// and a message that says what to do instead.
///
/// Such accounts are ordinary public surface here — `AccountComponent.compile` takes arbitrary
/// MASM and `AccountBuilder.withAuthComponent` accepts any component — and a consumer who writes
/// an auth procedure that reads conversion info has no way to attach it other than
/// `withFeeConversionInfo`, so this is exactly the caller the escape hatch exists for.
///
/// Also raises `FEE_CONVERSION_INFO_IGNORED` for the two components that pay the fee natively and
/// discard auth arguments, so this path and `submitNewTransactionBatch` report the same mistake
/// with the same code. It costs nothing extra — the components are already in hand — and without
/// it a caller branching on `FEE_CONVERSION_INFO_IGNORED` would find it worked for a batch and not
/// for the single transaction that batch is made of.
///
/// Still narrower than `reads_fee_conversion_info`: `AuthMultisigSmart` neither reads conversion
/// info under upstream's allowlist nor pays natively, so nothing can be concluded about it here
/// and it is left to upstream's own `FeeConversionInfoUnsupported`, which names the component it
/// rejected.
///
/// Costs one account-code read, and only for a request that declares conversion info.
async fn ensure_fee_conversion_info_classifiable(
    client: &Client<crate::ClientAuth>,
    account_id: NativeAccountId,
    request: &NativeTransactionRequest,
) -> Result<(), JsErr> {
    // Above the early return, not below it: `TransactionRequest::with_auth_arg` sets
    // `declares_fee_conversion_info` back to false, so a request whose commitment was replaced —
    // the exact mistake this refuses — returns false here. Gating the check on that flag made it
    // unreachable for the one case it exists to catch.
    ensure_fee_conversion_info_auth_arg_intact(request)?;

    if !request.declares_fee_conversion_info() {
        return Ok(());
    }

    let Some(components) = standard_auth_components(client, account_id).await? else {
        // Not in the store: nothing can execute against it, and upstream loads the account before
        // validating, so let its account-not-found error surface instead of pre-empting it.
        return Ok(());
    };

    // Exactly one, mirroring `auth_component_of`: it matches `(Some, None)` over the filtered
    // components and yields `None` for anything else, so two standard auth components are as
    // unclassifiable upstream as zero are. Checked before the native-payment question, and in the
    // same order as `ensure_batch_fee_conversion_info_supported`, so the two paths agree on which
    // code an account triggering both conditions gets.
    if components.len() != 1 {
        return Err(fee_conversion_info_unclassifiable_err(components.len()));
    }

    if pays_fee_natively(&components) {
        return Err(fee_conversion_info_ignored_err());
    }

    Ok(())
}

/// Fee conversion info for the chain's own fee asset, paired with a fresh salt.
///
/// Returns `None` when none should be committed. Since protocol 0.16 the fee is paid inside
/// the account's auth procedure and `fee::pay_fee` reads the conversion info from the
/// transaction's auth args, so a request built without it aborts with
/// `ERR_FEE_CONVERSION_INFO_MISSING` wherever `verification_base_fee` is non-zero. The
/// convenience constructors below return a finished request and expose no way to set an auth
/// arg afterwards, so attaching it here is the only point at which they can be made to work on
/// a fee-charging chain.
///
/// Two gates. A zero base fee keeps such chains byte-identical to before: no auth arg, no
/// advice entry. That matters because the auth arg is not free to set — a multisig flow reuses
/// it as the transaction summary salt, so inventing one where none is needed would change a
/// summary that callers may already be signing over. The second gate is the executing account's
/// auth component, for the reasons in `reads_fee_conversion_info`.
///
/// Reads the fee parameters from the store's sync height, while execution reads them from the
/// reference block — the same block only on the unanchored path, since `prepare_transaction` takes
/// the reference header from the anchor when one is supplied. So a request built at a sync height
/// whose base fee is zero and then executed against an anchor whose base fee is not carries no
/// conversion info, and an `AuthMultisig` or `AuthGuardedMultisig` account fails with
/// `FeeConversionInfoRequired` at execute time — after the summary has already gone out to
/// co-signers. Build the request and take the anchor at the same sync height.
async fn native_fee_conversion_info(
    client: &mut Client<crate::ClientAuth>,
    executing_account_id: NativeAccountId,
) -> Result<Option<(NativeFeeConversionInfo, NativeWord)>, JsErr> {
    let header = client.get_latest_block_header().await.map_err(|err| {
        js_error_with_context(
            err,
            &format!(
                "failed to read fee parameters from the latest block header while preparing a \
                 request for account {executing_account_id}"
            ),
        )
    })?;
    let fee_parameters = header.fee_parameters();
    if fee_parameters.verification_base_fee() == 0 {
        return Ok(None);
    }

    if !reads_fee_conversion_info(client, executing_account_id).await? {
        return Ok(None);
    }

    let conversion_info = NativeFeeConversionInfo::one_to_one(fee_parameters.fee_faucet_id());
    let salt = client.rng().draw_word();
    Ok(Some((conversion_info, salt)))
}

/// A request builder already carrying this chain's fee conversion info, where one is needed.
///
/// Every convenience constructor that already holds the client starts from this rather than
/// `TransactionRequestBuilder::new()`, and `feeAwareTransactionRequestBuilder` exposes it to
/// callers assembling a request themselves. `executing_account_id` names the account that will
/// execute the request, which is what decides whether conversion info is useful to it.
///
/// One request constructor remains unable to attach it: `buildPswapCancelByOrder` delegates request
/// building to miden-client, which builds from a bare `TransactionRequestBuilder`. There is no seam
/// to attach at without an upstream change, because a finished `TransactionRequest` cannot be
/// amended, so its requests abort with `ERR_FEE_CONVERSION_INFO_MISSING` on a fee-charging chain.
/// Cancelling by note through `newPswapCancelTransactionRequest` is the fee-paying alternative.
async fn fee_aware_builder(
    client: &mut Client<crate::ClientAuth>,
    executing_account_id: NativeAccountId,
) -> Result<NativeTransactionRequestBuilder, JsErr> {
    Ok(fee_aware_builder_and_declaration(client, executing_account_id).await?.0)
}

/// As `fee_aware_builder`, but also reports whether conversion info was in fact attached.
///
/// Only `feeAwareTransactionRequestBuilder` needs the flag, and only because the builder it hands
/// back is the caller's to keep mutating: the JS wrapper records the declaration so a later
/// `withAuthArg` can be refused for overwriting the commitment. The native builder cannot be asked
/// after the fact — its `auth_arg` clears the declaration as a side effect.
async fn fee_aware_builder_and_declaration(
    client: &mut Client<crate::ClientAuth>,
    executing_account_id: NativeAccountId,
) -> Result<(NativeTransactionRequestBuilder, bool), JsErr> {
    let mut builder = NativeTransactionRequestBuilder::new();
    let mut declares_fee_conversion_info = false;
    if let Some((conversion_info, salt)) =
        native_fee_conversion_info(client, executing_account_id).await?
    {
        builder = builder.fee_conversion_info(conversion_info, salt);
        declares_fee_conversion_info = true;
    }
    Ok((builder, declares_fee_conversion_info))
}
