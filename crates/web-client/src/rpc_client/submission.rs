//! Stateless submission of caller-prepared transactions and batches.

use js_export_macro::js_export;
use miden_client::block::BlockHeader as NativeBlockHeader;
use miden_client::rpc::encryption::{
    TransactionEncryptionKey as NativeTransactionEncryptionKey,
    seal_transaction_inputs,
};
use miden_client::transaction::{
    ProvenTransaction as NativeProvenTransaction,
    TransactionInputs as NativeTransactionInputs,
};
use miden_objects::prost::Message;
use miden_objects::{DecodeMessageExt, proto};
use miden_protocol::MIN_PROOF_SECURITY_LEVEL;
use miden_protocol::batch::{
    ProposedBatch as NativeProposedBatch,
    ProvenBatch as NativeProvenBatch,
};

use super::RpcClient;
use crate::models::block_header::BlockHeader;
use crate::models::proven_transaction::ProvenTransaction;
use crate::models::transaction_result::TransactionResult;
use crate::models::word::Word;
use crate::platform::{JsBytes, JsErr, bytes_to_js, from_str_err, js_to_bytes};
use crate::{create_rng, js_error_with_context};

/// Complete private inputs needed to validate a proven transaction.
///
/// These are plaintext until submission seals them for the validators. Keep their serialized
/// representation private. Serialization uses the canonical `miden_objects` Protobuf
/// `transaction.TransactionInputs` message, not the native Rust `TransactionInputs::to_bytes()`
/// encoding.
#[derive(Clone)]
#[js_export]
pub struct TransactionInputs(NativeTransactionInputs);

#[js_export]
impl TransactionInputs {
    /// Extracts the complete inputs from a transaction execution result.
    #[js_export(js_name = "fromTransactionResult")]
    pub fn from_transaction_result(result: &TransactionResult) -> TransactionInputs {
        TransactionInputs(result.native().into())
    }

    /// Serializes the plaintext inputs as a canonical `miden_objects` Protobuf message.
    pub fn serialize(&self) -> JsBytes {
        bytes_to_js(&proto::transaction::TransactionInputs::from(&self.0).encode_to_vec())
    }

    /// Decodes a canonical `miden_objects` Protobuf `TransactionInputs` message.
    ///
    /// Checks input, protocol configuration, and note-inclusion consistency against the supplied
    /// headers. It does not establish trust in those headers or execute the transaction.
    pub fn deserialize(bytes: JsBytes) -> Result<TransactionInputs, JsErr> {
        let bytes = js_to_bytes(&bytes);
        let message = proto::transaction::TransactionInputs::decode(bytes.as_slice())
            .map_err(|err| js_error_with_context(err, "failed to decode transaction inputs"))?;
        message
            .decode_and_build_unchecked()
            .map(TransactionInputs)
            .map_err(|err| js_error_with_context(err, "invalid transaction inputs"))
    }
}

impl_napi_from_value!(TransactionInputs);

/// A validator transaction-encryption key verified against caller-supplied trust anchors.
///
/// Obtain this through `RpcClient.getTransactionEncryptionKey()`. The key contains public
/// material only. Fetch a fresh key if submission reports that the validators no longer accept
/// its key ID.
#[derive(Clone)]
#[js_export]
pub struct TransactionEncryptionKey(NativeTransactionEncryptionKey, miden_client::Word);

#[js_export]
impl TransactionEncryptionKey {
    /// Returns the opaque identifier of the validator encryption key.
    #[js_export(js_name = "keyId")]
    pub fn key_id(&self) -> JsBytes {
        bytes_to_js(self.0.key_id())
    }
}

/// A caller-prepared batch proposal, including its ordered proven transactions and chain data.
///
/// Serialization uses the canonical `miden_objects` Protobuf `transaction.ProposedBatch` message.
/// This wrapper does not assemble, execute, or prove a batch.
#[derive(Clone)]
#[js_export]
pub struct ProposedBatch(NativeProposedBatch);

#[js_export]
impl ProposedBatch {
    /// Serializes the proposal as a canonical `miden_objects` Protobuf message.
    pub fn serialize(&self) -> JsBytes {
        bytes_to_js(&proto::transaction::ProposedBatch::from(&self.0).encode_to_vec())
    }

    /// Decodes a canonical `miden_objects` Protobuf `ProposedBatch` message.
    ///
    /// Verifies transaction proofs at the protocol's minimum security level and checks batch
    /// ordering, chain consistency, and note proofs. It does not authenticate the supplied chain.
    pub fn deserialize(bytes: JsBytes) -> Result<ProposedBatch, JsErr> {
        let bytes = js_to_bytes(&bytes);
        let message = proto::transaction::ProposedBatch::decode(bytes.as_slice())
            .map_err(|err| js_error_with_context(err, "failed to decode proposed batch"))?;
        message
            .decode_and_verify_with(MIN_PROOF_SECURITY_LEVEL)
            .map(ProposedBatch)
            .map_err(|err| js_error_with_context(err, "invalid proposed batch"))
    }
}

/// A batch proof produced outside this RPC client.
///
/// Serialization uses the canonical `miden_objects` Protobuf `transaction.ProvenBatch` message,
/// not the native Rust `ProvenBatch::to_bytes()` encoding.
#[derive(Clone)]
#[js_export]
pub struct ProvenBatch(NativeProvenBatch);

#[js_export]
impl ProvenBatch {
    /// Serializes the proven batch as a canonical `miden_objects` Protobuf message.
    pub fn serialize(&self) -> JsBytes {
        bytes_to_js(&proto::transaction::ProvenBatch::from(&self.0).encode_to_vec())
    }

    /// Decodes a canonical `miden_objects` Protobuf `ProvenBatch` message.
    ///
    /// Checks structural invariants. Submission also checks agreement with the provided proposal;
    /// the node verifies the batch execution proof.
    pub fn deserialize(bytes: JsBytes) -> Result<ProvenBatch, JsErr> {
        let bytes = js_to_bytes(&bytes);
        let message = proto::transaction::ProvenBatch::decode(bytes.as_slice())
            .map_err(|err| js_error_with_context(err, "failed to decode proven batch"))?;
        message
            .decode_and_build_unchecked()
            .map(ProvenBatch)
            .map_err(|err| js_error_with_context(err, "invalid proven batch"))
    }
}

#[js_export]
impl RpcClient {
    /// Fetches and verifies the validators' transaction-encryption key.
    ///
    /// `genesis_commitment` and `trusted_block_header` must be authenticated independently of
    /// this RPC response. The header supplies the trusted validator set. Fetching both trust
    /// anchors from an untrusted RPC endpoint does not authenticate the encryption key.
    ///
    /// No client, account, or local store is initialized, and the key is not cached.
    #[js_export(js_name = "getTransactionEncryptionKey")]
    pub async fn get_transaction_encryption_key(
        &self,
        genesis_commitment: &Word,
        trusted_block_header: &BlockHeader,
    ) -> Result<TransactionEncryptionKey, JsErr> {
        let header: NativeBlockHeader = trusted_block_header.into();
        let attested = self.inner.get_transaction_encryption_key().await.map_err(|err| {
            js_error_with_context(err, "failed to get transaction encryption key")
        })?;
        attested
            .verify(genesis_commitment.into(), header.validator_config())
            .map(|key| TransactionEncryptionKey(key, genesis_commitment.into()))
            .map_err(|err| {
                js_error_with_context(err, "failed to verify transaction encryption key")
            })
    }

    /// Submits an already-proven transaction without initializing a client or updating a store.
    ///
    /// Supply the complete plaintext inputs and a key from `getTransactionEncryptionKey()`.
    /// This method checks the inputs' account, reference block, and consumed-note commitments,
    /// then seals the inputs locally with fresh randomness before sending them to the node.
    ///
    /// Returns the node's chain tip at admission, not the block in which the transaction commits.
    /// An uncertain transport outcome may still have admitted the transaction; retain the proof
    /// and inputs to reconcile its status or retry the same transaction.
    #[js_export(js_name = "submitProvenTx")]
    pub async fn submit_proven_tx(
        &self,
        proven_transaction: &ProvenTransaction,
        transaction_inputs: &TransactionInputs,
        encryption_key: &TransactionEncryptionKey,
    ) -> Result<u32, JsErr> {
        let proven: NativeProvenTransaction = proven_transaction.into();
        validate_transaction_inputs(&proven, &transaction_inputs.0).map_err(from_str_err)?;
        let sealed = seal_transaction_inputs(
            &mut create_rng(None)?,
            &encryption_key.0,
            proven.id(),
            &transaction_inputs.0,
        )
        .map_err(|err| js_error_with_context(err, "failed to seal transaction inputs"))?;
        self.inner
            .set_genesis_commitment(encryption_key.1)
            .await
            .map_err(|err| js_error_with_context(err, "failed to configure RPC genesis"))?;
        self.inner
            .submit_proven_transaction(&proven, sealed)
            .await
            .map(|height| height.as_u32())
            .map_err(|err| js_error_with_context(err, "failed to submit proven transaction"))
    }

    /// Submits a caller-prepared proven batch without executing it or updating a local store.
    ///
    /// The proposal must describe the same batch as the proof. Supply exactly one complete
    /// plaintext input set per proposal transaction, in proposal order. Every set is checked and
    /// sealed independently against its corresponding transaction ID using fresh randomness.
    /// Transactions must satisfy the node's normal mempool admission rules.
    ///
    /// Returns the node's chain tip at admission, not the batch's eventual commit height.
    /// Retain all artifacts when a transport error leaves the submission outcome uncertain.
    ///
    /// In the browser, the input wrappers are consumed even when submission fails. Serialize
    /// them before calling and deserialize fresh wrappers for a retry. The batch proof, proposal,
    /// and encryption key are borrowed and remain reusable.
    #[js_export(js_name = "submitProvenTxBatch")]
    pub async fn submit_proven_tx_batch(
        &self,
        proven_batch: &ProvenBatch,
        proposed_batch: &ProposedBatch,
        transaction_inputs: Vec<TransactionInputs>,
        encryption_key: &TransactionEncryptionKey,
    ) -> Result<u32, JsErr> {
        let proven = proto::transaction::ProvenBatch::from(&proven_batch.0)
            .decode_and_verify_with(&proposed_batch.0)
            .map_err(|err| js_error_with_context(err, "proven batch does not match proposal"))?;
        let transactions = proposed_batch.0.transactions();
        if transaction_inputs.len() != transactions.len() {
            return Err(from_str_err(
                "batch submission requires one input set per transaction in proposal order",
            ));
        }
        for (transaction, inputs) in transactions.iter().zip(&transaction_inputs) {
            validate_transaction_inputs(transaction, &inputs.0).map_err(from_str_err)?;
        }
        let mut rng = create_rng(None)?;
        let sealed = transactions
            .iter()
            .zip(&transaction_inputs)
            .map(|(transaction, inputs)| {
                seal_transaction_inputs(&mut rng, &encryption_key.0, transaction.id(), &inputs.0)
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| js_error_with_context(err, "failed to seal batch transaction inputs"))?;
        self.inner
            .set_genesis_commitment(encryption_key.1)
            .await
            .map_err(|err| js_error_with_context(err, "failed to configure RPC genesis"))?;
        self.inner
            .submit_proven_batch(&proven, &proposed_batch.0, sealed)
            .await
            .map(|height| height.as_u32())
            .map_err(|err| js_error_with_context(err, "failed to submit proven transaction batch"))
    }
}

fn validate_transaction_inputs(
    proven: &NativeProvenTransaction,
    inputs: &NativeTransactionInputs,
) -> Result<(), &'static str> {
    if proven.account_id() != inputs.account().id()
        || proven.account_update().initial_state_commitment()
            != inputs.account().initial_commitment()
    {
        return Err("transaction inputs do not match the proven transaction's initial account");
    }
    if proven.ref_block_num() != inputs.ref_block()
        || proven.ref_block_commitment() != inputs.block_header().commitment()
    {
        return Err("transaction inputs do not match the proven transaction's reference block");
    }
    if proven.input_notes().commitment() != inputs.input_notes().commitment() {
        return Err("transaction inputs do not match the proven transaction's consumed notes");
    }
    Ok(())
}

#[cfg(all(test, feature = "nodejs"))]
mod tests {
    use alloc::collections::BTreeMap;
    use alloc::sync::Arc;

    use miden_client::testing::MockChain;
    use miden_client::testing::mock::MockRpcApi;
    use miden_client::utils::{Deserializable, Serializable};
    use miden_protocol::account::{
        AccountCode,
        AccountId,
        AccountIdVersion,
        AccountStorageHeader,
        AccountType,
        AccountUpdateDetails,
        AssetCallbackFlag,
        PartialAccount,
        PartialStorage,
    };
    use miden_protocol::asset::PartialVault;
    use miden_protocol::crypto::dsa::eddsa_25519_sha512::KeyExchangeKey;
    use miden_protocol::crypto::ies::{SealedMessage, UnsealingKey};
    use miden_protocol::testing::dummy_execution_proof;
    use miden_protocol::transaction::{OutputNote, TxAccountUpdate};
    use miden_protocol::{Felt, Word as NativeWord};

    use super::*;

    #[tokio::test]
    async fn submissions_send_the_verified_genesis_in_rpc_headers() {
        for batch in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let (headers_tx, headers_rx) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut connection = h2::server::handshake(socket).await.unwrap();
                let (request, mut respond) = connection.accept().await.unwrap().unwrap();
                headers_tx
                    .send((request.uri().path().to_owned(), request.headers().clone()))
                    .unwrap();
                let response = http::Response::builder()
                    .header("content-type", "application/grpc")
                    .body(())
                    .unwrap();
                let mut response = respond.send_response(response, false).unwrap();
                let mut trailers = http::HeaderMap::new();
                trailers.insert("grpc-status", "3".parse().unwrap());
                trailers.insert("grpc-message", "header captured".parse().unwrap());
                response.send_trailers(trailers).unwrap();
                while connection.accept().await.is_some() {}
            });
            let (_, _, proposal, proven, inputs) = batch_fixture();
            let rpc =
                RpcClient::new(crate::models::endpoint::Endpoint::new(endpoint).unwrap()).unwrap();
            let genesis = NativeWord::from([11_u32; 4]);
            let secret = KeyExchangeKey::with_rng(&mut create_rng(None).unwrap());
            let key = TransactionEncryptionKey(
                NativeTransactionEncryptionKey::new_unattested(
                    vec![9],
                    secret.public_key(),
                    genesis,
                ),
                genesis,
            );
            let result = if batch {
                rpc.submit_proven_tx_batch(&proven, &proposal, inputs, &key).await
            } else {
                let transaction = proposal.0.transactions()[0].as_ref().into();
                rpc.submit_proven_tx(&transaction, &inputs[0], &key).await
            };
            assert!(result.unwrap_err().reason.contains("header captured"));
            let (path, headers) = headers_rx.await.unwrap();
            server.abort();
            let method = if batch { "SubmitProvenTxBatch" } else { "SubmitProvenTx" };
            assert!(path.ends_with(method), "unexpected RPC path: {path}");
            let accept = headers.get("accept").unwrap().to_str().unwrap();
            assert!(
                accept.split("; ").any(|part| part == format!("genesis={}", genesis.to_hex())),
                "{method} omitted the verified genesis: {accept}",
            );
        }
    }

    fn batch_fixture()
    -> (RpcClient, Arc<MockRpcApi>, ProposedBatch, ProvenBatch, Vec<TransactionInputs>) {
        let chain = MockChain::new();
        let inputs: Vec<_> = [7, 8]
            .into_iter()
            .map(|seed| {
                let account = PartialAccount::new(
                    AccountId::dummy(
                        [seed; 15],
                        AccountIdVersion::Version1,
                        AccountType::Private,
                        AssetCallbackFlag::Disabled,
                    ),
                    Felt::from(1_u32),
                    AccountCode::mock(),
                    PartialStorage::new(AccountStorageHeader::new(vec![]).unwrap(), []).unwrap(),
                    PartialVault::new(NativeWord::empty()),
                    None,
                )
                .unwrap();
                TransactionInputs(chain.get_transaction_inputs(account, &[], &[]).unwrap())
            })
            .collect();
        let transactions = inputs
            .iter()
            .map(|inputs| {
                let update = TxAccountUpdate::new(
                    inputs.0.account().id(),
                    inputs.0.account().initial_commitment(),
                    NativeWord::from([2_u32; 4]),
                    NativeWord::empty(),
                    AccountUpdateDetails::Private,
                )
                .unwrap();
                Arc::new(
                    NativeProvenTransaction::new(
                        update,
                        inputs.0.input_notes().to_commitments(),
                        Vec::<OutputNote>::new(),
                        inputs.0.ref_block(),
                        inputs.0.block_header().commitment(),
                        inputs.0.ref_block() + 10,
                        dummy_execution_proof(),
                    )
                    .unwrap(),
                )
            })
            .collect();
        // Dummy transaction proofs keep this transport test independent of proving cost.
        // The exported decoder's proof-verification requirement is exercised separately below.
        let proposal = NativeProposedBatch::new_unverified(
            transactions,
            inputs[0].0.block_header().clone(),
            inputs[0].0.blockchain().clone(),
            BTreeMap::new(),
        )
        .unwrap();
        let proven = NativeProvenBatch::new(
            proposal.reference_block_header().commitment(),
            proposal.reference_block_header().block_num(),
            proposal.account_updates().values().cloned(),
            proposal.input_notes().clone(),
            proposal.output_notes().to_vec(),
            proposal.batch_expiration_block_num(),
            proposal.transaction_headers(),
            dummy_execution_proof(),
        )
        .unwrap();
        let transport = Arc::new(MockRpcApi::new(chain));
        let rpc = RpcClient { inner: transport.clone() };
        (rpc, transport, ProposedBatch(proposal), ProvenBatch(proven), inputs)
    }

    #[tokio::test]
    async fn submissions_seal_inputs_and_reject_mismatched_payloads() {
        let (rpc, transport, proposal, proven, inputs) = batch_fixture();
        let secret = KeyExchangeKey::with_rng(&mut create_rng(None).unwrap());
        let genesis = NativeWord::from([11_u32; 4]);
        let key = TransactionEncryptionKey(
            NativeTransactionEncryptionKey::new_unattested(vec![9], secret.public_key(), genesis),
            genesis,
        );
        let unsealing_key = UnsealingKey::X25519XChaCha20Poly1305(secret);
        let decoded_inputs: Vec<_> = inputs
            .iter()
            .map(|inputs| TransactionInputs::deserialize(inputs.serialize()).unwrap())
            .collect();

        let transaction: ProvenTransaction = proposal.0.transactions()[0].as_ref().into();
        let error = rpc.submit_proven_tx(&transaction, &decoded_inputs[1], &key).await.unwrap_err();
        assert!(error.reason.contains("initial account"));
        let height = rpc.submit_proven_tx(&transaction, &decoded_inputs[0], &key).await.unwrap();
        assert_eq!(height, transport.get_chain_tip_block_num().as_u32());

        for _ in 0..2 {
            let height = rpc
                .submit_proven_tx_batch(&proven, &proposal, decoded_inputs.clone(), &key)
                .await
                .unwrap();
            assert_eq!(height, transport.get_chain_tip_block_num().as_u32());
        }
        let submitted = transport.submitted_batch_sealed_inputs();
        assert_eq!(submitted.len(), 2);
        for (index, (transaction, inputs)) in
            proposal.0.transactions().iter().zip(&inputs).enumerate()
        {
            let sealed = &submitted[0][index];
            assert_eq!(sealed.key_id(), &[9]);
            assert_ne!(sealed.ciphertext(), submitted[1][index].ciphertext());
            // Reconstruct the validator's documented associated-data transcript independently.
            let mut associated_data = b"MIDEN_TX_INPUT_SEAL_V1".to_vec();
            associated_data.extend_from_slice(&1_u32.to_le_bytes());
            associated_data.extend_from_slice(&1_u32.to_le_bytes());
            associated_data.push(9);
            associated_data.extend_from_slice(&genesis.to_bytes());
            associated_data.extend_from_slice(&transaction.id().as_word().to_bytes());
            let plaintext = unsealing_key
                .unseal_bytes_with_associated_data(
                    SealedMessage::read_from_bytes(sealed.ciphertext()).unwrap(),
                    &associated_data,
                )
                .unwrap();
            // Native Merkle stores serialize hash-map iteration order, which can change after
            // decoding the public Protobuf representation without changing any input data.
            let unsealed_inputs = NativeTransactionInputs::read_from_bytes(&plaintext).unwrap();
            assert_eq!(unsealed_inputs, inputs.0);
        }

        let mut reversed = inputs.clone();
        reversed.reverse();
        let error = rpc
            .submit_proven_tx_batch(&proven, &proposal, reversed, &key)
            .await
            .unwrap_err();
        assert!(error.reason.contains("initial account"));
        let error = rpc
            .submit_proven_tx_batch(&proven, &proposal, vec![inputs[0].clone()], &key)
            .await
            .unwrap_err();
        assert!(error.reason.contains("one input set per transaction"));

        let mut changed: proto::transaction::ProvenBatch = (&proven.0).into();
        changed.reference_block_commitment = Some(NativeWord::from([99_u32; 4]).into());
        let changed = ProvenBatch(changed.decode_and_build_unchecked().unwrap());
        let error =
            rpc.submit_proven_tx_batch(&changed, &proposal, inputs, &key).await.unwrap_err();
        assert!(error.reason.contains("does not match proposal"));
        assert_eq!(transport.submitted_batch_sealed_inputs().len(), 2);
    }

    #[test]
    fn proposed_batch_decoder_rejects_invalid_transaction_proofs() {
        let (_, _, proposal, ..) = batch_fixture();
        let error = ProposedBatch::deserialize(proposal.serialize())
            .err()
            .expect("an unchecked dummy transaction proof must not cross the exported decoder");
        assert!(error.reason.contains("failed to verify transaction"));
    }
}
