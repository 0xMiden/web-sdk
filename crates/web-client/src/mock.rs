use alloc::sync::Arc;

#[cfg(feature = "browser")]
use idxdb_store::IdxdbStore;
use js_export_macro::js_export;
use miden_client::block::BlockNumber;
use miden_client::crypto::eddsa_25519_sha512::KeyExchangeKey;
use miden_client::rpc::encryption::TransactionEncryptionKey;
use miden_client::store::Store;
use miden_client::testing::MockChain;
use miden_client::testing::mock::MockRpcApi;
use miden_client::testing::note_transport::{MockNoteTransportApi, MockNoteTransportNode};
use miden_client::utils::{Deserializable, RwLock, Serializable};
use rand::SeedableRng;
use rand::rngs::StdRng;

#[cfg(feature = "browser")]
use crate::WebKeyStore;
use crate::platform::{JsErr, from_str_err};
use crate::{WebClient, create_rng, js_error_with_context};

#[cfg(feature = "browser")]
#[js_export]
impl WebClient {
    /// Creates a new client with a mock RPC API. Useful for testing purposes and proof-of-concept
    /// applications as it uses a mock chain that simulates the behavior of a real node.
    #[js_export(js_name = "createMockClient")]
    pub async fn create_mock_client(
        &self,
        seed: Option<Vec<u8>>,
        serialized_mock_chain: Option<Vec<u8>>,
        serialized_mock_note_transport_node: Option<Vec<u8>>,
    ) -> Result<String, JsErr> {
        let mock_rpc_api = match serialized_mock_chain {
            Some(chain) => {
                Arc::new(MockRpcApi::new(MockChain::read_from_bytes(&chain).map_err(|err| {
                    js_error_with_context(err, "failed to deserialize mock chain")
                })?))
            },
            None => Arc::new(MockRpcApi::default()),
        };

        let mock_note_transport_api = match serialized_mock_note_transport_node {
            Some(node_bytes) => {
                let node = MockNoteTransportNode::read_from_bytes(&node_bytes).map_err(|err| {
                    js_error_with_context(err, "failed to deserialize mock note transport node")
                })?;
                Arc::new(MockNoteTransportApi::new(Arc::new(RwLock::new(node))))
            },
            None => Arc::new(MockNoteTransportApi::default()),
        };

        let store_name = "mock_client_db".to_owned();
        let rng = create_rng(seed)?;
        let store: Arc<dyn Store> = Arc::new(
            IdxdbStore::new(store_name.clone())
                .await
                .map_err(|_| from_str_err("Failed to initialize IdxdbStore"))?,
        );
        let keystore = WebKeyStore::new_with_callbacks(rng, store_name, None, None, None);

        self.setup_client(
            mock_rpc_api.clone(),
            store,
            keystore,
            rng,
            Some(mock_note_transport_api.clone()),
        )
        .await?;

        self.seed_mock_transaction_encryption_key().await?;

        *self.mock_rpc_api.lock().await = Some(mock_rpc_api);
        *self.mock_note_transport_api.lock().await = Some(mock_note_transport_api);

        Ok("Client created successfully".to_string())
    }
}

#[cfg(feature = "nodejs")]
#[napi_derive::napi]
impl WebClient {
    /// Creates a new client with a mock RPC API backed by SQLite storage.
    #[napi(js_name = "createMockClient")]
    pub async fn create_mock_client(
        &self,
        db_path: String,
        keystore_path: String,
        seed: Option<Vec<u8>>,
        serialized_mock_chain: Option<Vec<u8>>,
        serialized_mock_note_transport_node: Option<Vec<u8>>,
    ) -> Result<String, JsErr> {
        let mock_rpc_api = match serialized_mock_chain {
            Some(chain) => {
                Arc::new(MockRpcApi::new(MockChain::read_from_bytes(&chain).map_err(|err| {
                    js_error_with_context(err, "failed to deserialize mock chain")
                })?))
            },
            None => Arc::new(MockRpcApi::default()),
        };

        let mock_note_transport_api = match serialized_mock_note_transport_node {
            Some(node_bytes) => {
                let node = MockNoteTransportNode::read_from_bytes(&node_bytes).map_err(|err| {
                    js_error_with_context(err, "failed to deserialize mock note transport node")
                })?;
                Arc::new(MockNoteTransportApi::new(Arc::new(RwLock::new(node))))
            },
            None => Arc::new(MockNoteTransportApi::default()),
        };

        let rng = create_rng(seed)?;

        let store: Arc<dyn Store> = Arc::new(
            miden_client_sqlite_store::SqliteStore::new(db_path.into())
                .await
                .map_err(|e| from_str_err(&format!("Failed to initialize SqliteStore: {e}")))?,
        );

        let keystore = miden_client::keystore::FilesystemKeyStore::new(keystore_path.into())
            .map_err(|e| from_str_err(&format!("Failed to initialize keystore: {e}")))?;

        self.setup_client(
            mock_rpc_api.clone(),
            store,
            keystore,
            rng,
            Some(mock_note_transport_api.clone()),
        )
        .await?;

        self.seed_mock_transaction_encryption_key().await?;

        *self.mock_rpc_api.lock().await = Some(mock_rpc_api);
        *self.mock_note_transport_api.lock().await = Some(mock_note_transport_api);

        Ok("Mock client created successfully".to_string())
    }
}

impl WebClient {
    /// Gives a mock-backed client the transaction encryption key that submission seals against.
    ///
    /// `MockRpcApi` refuses to serve a key, because attesting one needs a validator signature the
    /// mock chain cannot produce. The mock also discards the sealed inputs it receives, so an
    /// unattested key is enough: sealing still runs its real transcript and wire path, only the
    /// attestation check is skipped.
    ///
    /// Must run after the client is in place and its genesis header stored, since the key is
    /// scoped to the genesis commitment.
    async fn seed_mock_transaction_encryption_key(&self) -> Result<(), JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| from_str_err("Client not initialized"))?;

        let genesis_commitment = client
            .get_block_header_by_num(BlockNumber::GENESIS)
            .await
            .map_err(|err| js_error_with_context(err, "failed to read the genesis block header"))?
            .ok_or_else(|| {
                from_str_err("genesis block header must be in place before the mock client can seal transaction inputs")
            })?
            .0
            .commitment();

        client.seed_transaction_encryption_key(TransactionEncryptionKey::new_unattested(
            b"mock-key-id".to_vec(),
            KeyExchangeKey::with_rng(&mut StdRng::from_rng(&mut rand::rng())).public_key(),
            genesis_commitment,
        ));

        Ok(())
    }
}

#[js_export]
impl WebClient {
    /// Returns the inner serialized mock chain if it exists.
    #[js_export(js_name = "serializeMockChain")]
    pub async fn serialize_mock_chain(&self) -> Result<Vec<u8>, JsErr> {
        let guard = self.mock_rpc_api.lock().await;
        guard.as_ref().map(|api| api.mock_chain.read().to_bytes()).ok_or_else(|| {
            from_str_err("Mock chain is not initialized. Create a mock client first.")
        })
    }

    /// Returns the inner serialized mock note transport node if it exists.
    #[js_export(js_name = "serializeMockNoteTransportNode")]
    pub async fn serialize_mock_note_transport_node(&self) -> Result<Vec<u8>, JsErr> {
        let guard = self.mock_note_transport_api.lock().await;
        guard.as_ref().map(|api| api.mock_node.read().to_bytes()).ok_or_else(|| {
            from_str_err("Mock note transport node is not initialized. Create a mock client first.")
        })
    }

    #[js_export(js_name = "proveBlock")]
    pub async fn prove_block(&self) -> Result<(), JsErr> {
        let guard = self.mock_rpc_api.lock().await;
        match guard.as_ref() {
            Some(api) => {
                api.prove_block();
                Ok(())
            },
            None => Err(from_str_err("WebClient does not have a mock chain.")),
        }
    }

    #[js_export(js_name = "usesMockChain")]
    pub async fn uses_mock_chain(&self) -> bool {
        self.mock_rpc_api.lock().await.is_some()
    }
}
