use miden_client::testing::MockChain;
use miden_objects::prost::Message;
use miden_objects::proto;
use tokio::sync::mpsc;

use super::*;

/// Serves genesis and captures real gRPC headers without consuming an invitation code.
async fn registration_server(
    genesis_response: Vec<u8>,
) -> (
    RpcClient,
    mpsc::UnboundedReceiver<(String, http::HeaderMap)>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (requests_tx, requests_rx) = mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut connection = h2::server::handshake(socket).await.unwrap();
        while let Some(request) = connection.accept().await {
            let (request, mut respond) = request.unwrap();
            let path = request.uri().path().to_owned();
            requests_tx.send((path.clone(), request.headers().clone())).unwrap();
            let message = if path.ends_with("/GetBlockHeaderByNumber") {
                genesis_response.clone()
            } else {
                assert!(path.ends_with("/RegisterAccount"), "unexpected RPC path: {path}");
                vec![]
            };
            let response = http::Response::builder()
                .header("content-type", "application/grpc")
                .body(())
                .unwrap();
            let mut response = respond.send_response(response, false).unwrap();
            let mut frame = vec![0];
            frame.extend_from_slice(&u32::try_from(message.len()).unwrap().to_be_bytes());
            frame.extend(message);
            response.send_data(frame.into(), false).unwrap();
            let mut trailers = http::HeaderMap::new();
            trailers.insert("grpc-status", "0".parse().unwrap());
            response.send_trailers(trailers).unwrap();
        }
    });
    let rpc = RpcClient::new(Endpoint::new(endpoint).unwrap()).unwrap();
    (rpc, requests_rx, server)
}

#[tokio::test]
async fn registration_sends_genesis_without_a_store_or_prior_submission() {
    let chain = MockChain::new();
    let genesis = chain.genesis_block_header();
    // GetBlockHeaderByNumberResponse.block_header is length-delimited field 1.
    let mut response = vec![0x0a];
    proto::blockchain::BlockHeader::from(&genesis)
        .encode_length_delimited(&mut response)
        .unwrap();
    for prefetch in [false, true] {
        let (rpc, mut requests, server) = registration_server(response.clone()).await;
        if prefetch {
            rpc.get_block_header_by_number(Some(0), None).await.unwrap();
            requests.recv().await.unwrap();
        }
        let account = AccountId::from_hex("0xc6da5c4573a3731151114a1aa8fe8e".into()).unwrap();
        for _ in 0..2 {
            rpc.register_account(&account, "invitation-code".into()).await.unwrap();
        }
        server.abort();
        let captured: Vec<_> = std::iter::from_fn(|| requests.try_recv().ok()).collect();
        for (_, headers) in captured.iter().filter(|(path, _)| path.ends_with("/RegisterAccount")) {
            let accept = headers.get("accept").unwrap().to_str().unwrap();
            assert!(
                accept
                    .split("; ")
                    .any(|part| part == format!("genesis={}", genesis.commitment().to_hex())),
                "registration omitted genesis: {accept}",
            );
        }
        assert_eq!(captured.len(), 3, "fetch genesis once, then register twice");
        assert!(captured[0].0.ends_with("/GetBlockHeaderByNumber"));
        assert!(captured[1..].iter().all(|(path, _)| path.ends_with("/RegisterAccount")));
    }
}

#[tokio::test]
async fn registration_preserves_an_already_configured_genesis() {
    let (rpc, mut requests, server) = registration_server(vec![]).await;
    let genesis = miden_client::Word::from([11_u32; 4]);
    rpc.configure_genesis(genesis).await.unwrap();
    let account = AccountId::from_hex("0xc6da5c4573a3731151114a1aa8fe8e".into()).unwrap();
    rpc.register_account(&account, "invitation-code".into()).await.unwrap();
    server.abort();
    let (path, headers) = requests.recv().await.unwrap();
    assert!(path.ends_with("/RegisterAccount"));
    let accept = headers.get("accept").unwrap().to_str().unwrap();
    assert!(accept.contains(&format!("genesis={}", genesis.to_hex())));
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn registration_does_not_send_the_code_when_genesis_cannot_be_loaded() {
    // A successful response without a block header is malformed.
    let (rpc, mut requests, server) = registration_server(vec![]).await;
    let account = AccountId::from_hex("0xc6da5c4573a3731151114a1aa8fe8e".into()).unwrap();
    let error = rpc.register_account(&account, "invitation-code".into()).await.unwrap_err();
    server.abort();
    assert!(error.reason.contains("failed to get genesis for account registration"));
    assert!(requests.recv().await.unwrap().0.ends_with("/GetBlockHeaderByNumber"));
    assert!(requests.try_recv().is_err());
}

// TRANSACTION LOGS
// ================================================================================================

mod transaction_logs {
    use alloc::boxed::Box;
    use alloc::format;
    use alloc::string::String;

    use miden_client::account::standards::wallets::BasicWallet;
    use miden_client::account::{AccountId as NativeAccountId, AccountType};
    use miden_client::assembly::CodeBuilder;
    use miden_client::rpc::{RpcEndpoint, RpcError};
    use miden_client::testing::mock::MockRpcApi;
    use miden_client::testing::{Auth, MockChainBuilder};
    use miden_client::transaction::{
        LogTopic,
        TransactionId as NativeTransactionId,
        TransactionLog,
        TransactionLogs,
    };
    use miden_client::{Felt, Word as NativeWord};
    use miden_protocol::account::component::AccountComponentMetadata;
    use miden_protocol::account::{AccountBuilder, AccountComponent};

    use super::*;
    use crate::models::transaction_id::TransactionId;

    const LOG_CONTENT: [u32; 4] = [1, 2, 3, 4];

    /// An account component that emits two logs with different topics: one with one content word
    /// and one without content.
    const LOG_COMPONENT_CODE: &str = r"
        use miden::protocol::tx

        @account_procedure
        @locals(4)
        pub proc emit_logs
            push.{content} loc_storew_le.0 dropw

            locaddr.0 push.1 push.29.17
            # => [topic_suffix, topic_prefix, num_words, content_ptr]
            exec.tx::add_log_from_memory

            locaddr.0 push.0 push.31.19
            # => [topic_suffix, topic_prefix, num_words, content_ptr]
            exec.tx::add_log_from_memory
        end
    ";

    fn log_content() -> NativeWord {
        NativeWord::from(LOG_CONTENT.map(Felt::from))
    }

    /// The logs that one call to `emit_logs` produces for `account_id`.
    fn expected_logs(account_id: NativeAccountId) -> TransactionLogs {
        let topic =
            |suffix: u32, prefix: u32| LogTopic::new(Felt::from(suffix), Felt::from(prefix));
        TransactionLogs::new(vec![
            TransactionLog::new(account_id, topic(17, 29), vec![log_content()]).unwrap(),
            TransactionLog::new(account_id, topic(19, 31), vec![]).unwrap(),
        ])
        .unwrap()
    }

    /// A node whose chain holds one committed transaction of an account of `account_type`. The
    /// transaction emitted the logs of `emit_logs`.
    async fn node_with_logs(
        account_type: AccountType,
    ) -> (RpcClient, Arc<MockRpcApi>, NativeAccountId, NativeTransactionId) {
        let code = LOG_COMPONENT_CODE.replace("{content}", &log_content().to_hex());
        let component = AccountComponent::new(
            CodeBuilder::default().compile_component_code("test::logs", code).unwrap(),
            vec![],
            AccountComponentMetadata::mock("test::logs"),
        )
        .unwrap();
        let root = component.get_procedure_root_by_path("test::logs::emit_logs").unwrap();
        let account = AccountBuilder::new([51; 32])
            .account_type(account_type)
            .with_component(component)
            .with_components(Auth::IncrNonce)
            .with_component(BasicWallet)
            .build_existing()
            .unwrap();
        let account_id = account.id();

        let mut chain =
            MockChainBuilder::with_accounts([account.clone()]).unwrap().build().unwrap();
        chain.prove_next_block().unwrap();
        let script = CodeBuilder::default()
            .compile_tx_script(format!(
                "use miden::core::sys
                @transaction_script
                pub proc main
                    call.{root} exec.sys::truncate_stack
                end",
            ))
            .unwrap();
        let executed =
            Box::pin(chain.build_transaction(account).tx_script(script).build().unwrap().execute())
                .await
                .unwrap();
        assert_eq!(executed.logs(), &expected_logs(account_id));
        let transaction_id = executed.id();

        let transport = Arc::new(MockRpcApi::new(chain));
        transport.add_pending_executed_transaction(&executed);
        transport.prove_block();
        let rpc = RpcClient::from_transport(transport.clone(), String::new());

        (rpc, transport, account_id, transaction_id)
    }

    fn unknown_transaction_id() -> TransactionId {
        NativeTransactionId::from_raw(NativeWord::from([Felt::from(7u32); 4])).into()
    }

    #[tokio::test]
    async fn node_returns_the_logs_of_a_public_account() {
        let (rpc, transport, account_id, transaction_id) =
            node_with_logs(AccountType::Public).await;

        let info = rpc
            .get_transaction_logs(&account_id.into(), &transaction_id.into())
            .await
            .unwrap()
            .expect("the node holds the transaction");

        assert_eq!(info.transaction_id().to_hex(), transaction_id.to_hex());
        assert_eq!(info.account_id().to_string(), AccountId::from(account_id).to_string());
        assert_eq!(info.block_num(), transport.get_chain_tip_block_num().as_u32());
        assert_eq!(info.transaction_index(), 0);

        let expected = expected_logs(account_id);
        assert_eq!(NativeWord::from(&info.logs_commitment()), expected.commitment());

        // The binding returns the logs in emission order, with the content of each one.
        let logs = info.logs().expect("a public account has its logs on the node");
        assert_eq!(NativeWord::from(&logs.commitment()), expected.commitment());
        let logs = logs.logs();
        let topic = |log: &crate::models::transaction_logs::TransactionLog| {
            (Felt::from(&log.topic_suffix()), Felt::from(&log.topic_prefix()))
        };
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].emitter().to_string(), AccountId::from(account_id).to_string());
        assert_eq!(topic(&logs[0]), (Felt::from(17u32), Felt::from(29u32)));
        assert_eq!(logs[0].content().len(), 1);
        assert_eq!(NativeWord::from(&logs[0].content()[0]), log_content());
        assert_eq!(topic(&logs[1]), (Felt::from(19u32), Felt::from(31u32)));
        assert!(logs[1].content().is_empty());
    }

    #[tokio::test]
    async fn node_returns_only_the_commitment_for_a_private_account() {
        let (rpc, _transport, account_id, transaction_id) =
            node_with_logs(AccountType::Private).await;

        let info = rpc
            .get_transaction_logs(&account_id.into(), &transaction_id.into())
            .await
            .unwrap()
            .expect("the node holds the transaction");

        assert!(info.logs().is_none());
        assert_eq!(
            NativeWord::from(&info.logs_commitment()),
            expected_logs(account_id).commitment()
        );
    }

    #[tokio::test]
    async fn node_has_no_logs_for_an_unknown_transaction_or_another_account() {
        let (rpc, _transport, account_id, transaction_id) =
            node_with_logs(AccountType::Public).await;

        let unknown = rpc
            .get_transaction_logs(&account_id.into(), &unknown_transaction_id())
            .await
            .unwrap();
        assert!(unknown.is_none());

        let other_account = AccountId::from_hex("0xc6da5c4573a3731151114a1aa8fe8e".into()).unwrap();
        let wrong_account =
            rpc.get_transaction_logs(&other_account, &transaction_id.into()).await.unwrap();
        assert!(wrong_account.is_none());
    }

    #[tokio::test]
    async fn a_node_failure_is_reported_and_does_not_read_as_no_logs() {
        let (rpc, transport, account_id, transaction_id) =
            node_with_logs(AccountType::Public).await;
        transport.fail_next_call(
            RpcEndpoint::GetTransactionLogs,
            RpcError::InvalidResponse("logs do not match the commitment".into()),
        );

        let error = rpc
            .get_transaction_logs(&account_id.into(), &transaction_id.into())
            .await
            .err()
            .expect("the failure reaches the caller");
        assert!(error.reason.contains("failed to get transaction logs"), "{}", error.reason);
        assert!(error.reason.contains("logs do not match the commitment"), "{}", error.reason);

        // The failure is served once, so the next call reaches the chain.
        let info = rpc
            .get_transaction_logs(&account_id.into(), &transaction_id.into())
            .await
            .unwrap();
        assert!(info.is_some());
    }
}
