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
    rpc.inner.set_genesis_commitment(genesis).await.unwrap();
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
