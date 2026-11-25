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

/// Appends a length-delimited protobuf field.
fn proto_bytes(out: &mut Vec<u8>, tag: u8, bytes: &[u8]) {
    out.push(tag);
    out.push(u8::try_from(bytes.len()).unwrap());
    out.extend_from_slice(bytes);
}

#[tokio::test]
async fn get_status_reports_the_node_and_block_producer_status() {
    // MempoolStats { unbatched_transactions: 3, proposed_batches: 2, proven_batches: 1 }.
    let mempool = [0x08, 3, 0x10, 2, 0x18, 1];
    let mut producer = Vec::new();
    proto_bytes(&mut producer, 0x0a, b"0.18.1");
    proto_bytes(&mut producer, 0x12, b"connected");
    proto_bytes(&mut producer, 0x1a, &mempool);
    producer.push(0x25); // chain_tip, fixed32
    producer.extend_from_slice(&119_u32.to_le_bytes());
    let mut response = Vec::new();
    proto_bytes(&mut response, 0x0a, b"0.18.2");
    response.push(0x1d); // chain_tip, fixed32
    response.extend_from_slice(&120_u32.to_le_bytes());
    proto_bytes(&mut response, 0x22, &producer);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut connection = h2::server::handshake(socket).await.unwrap();
        while let Some(request) = connection.accept().await {
            let (request, mut respond) = request.unwrap();
            assert!(request.uri().path().ends_with("/Status"), "unexpected RPC path");
            let head = http::Response::builder()
                .header("content-type", "application/grpc")
                .body(())
                .unwrap();
            let mut body = respond.send_response(head, false).unwrap();
            let mut frame = vec![0];
            frame.extend_from_slice(&u32::try_from(response.len()).unwrap().to_be_bytes());
            frame.extend(response.clone());
            body.send_data(frame.into(), false).unwrap();
            let mut trailers = http::HeaderMap::new();
            trailers.insert("grpc-status", "0".parse().unwrap());
            body.send_trailers(trailers).unwrap();
        }
    });
    let rpc = RpcClient::new(Endpoint::new(endpoint).unwrap()).unwrap();
    let status = rpc.get_status().await.unwrap();
    server.abort();

    assert_eq!(status.version(), "0.18.2");
    assert_eq!(status.chain_tip(), 120);
    assert!(status.genesis_commitment().is_none());
    let producer = status.block_producer().unwrap();
    assert_eq!(producer.version(), "0.18.1");
    assert_eq!(producer.status(), "connected");
    assert_eq!(producer.chain_tip(), 119);
    let mempool = producer.mempool_stats().unwrap();
    assert_eq!(
        (
            mempool.unbatched_transactions(),
            mempool.proposed_batches(),
            mempool.proven_batches()
        ),
        (3, 2, 1)
    );
}

#[tokio::test]
async fn get_status_rejects_when_the_node_is_unreachable() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let rpc = RpcClient::new(Endpoint::new(endpoint).unwrap()).unwrap();
    let Err(error) = rpc.get_status().await else {
        panic!("an unreachable node answered");
    };
    assert!(error.reason.contains("failed to get node status"));
}

/// Length-delimited protobuf field with a varint length.
fn ld(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let mut len = payload.len();
    while len >= 0x80 {
        out.push((len & 0x7f) as u8 | 0x80);
        len >>= 7;
    }
    out.push(len as u8);
    out.extend_from_slice(payload);
    out
}

/// Serves each request with `answer(path)` as a gRPC response.
async fn serve(
    answer: impl Fn(&str) -> Vec<u8> + Send + 'static,
) -> (RpcClient, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut connection = h2::server::handshake(socket).await.unwrap();
        while let Some(request) = connection.accept().await {
            let (request, mut respond) = request.unwrap();
            let message = answer(request.uri().path());
            let head = http::Response::builder()
                .header("content-type", "application/grpc")
                .body(())
                .unwrap();
            let mut body = respond.send_response(head, false).unwrap();
            let mut frame = vec![0];
            frame.extend_from_slice(&u32::try_from(message.len()).unwrap().to_be_bytes());
            frame.extend(message);
            body.send_data(frame.into(), false).unwrap();
            let mut trailers = http::HeaderMap::new();
            trailers.insert("grpc-status", "0".parse().unwrap());
            body.send_trailers(trailers).unwrap();
        }
    });
    (RpcClient::new(Endpoint::new(endpoint).unwrap()).unwrap(), server)
}

/// A `GetBlockHeaderByNumberResponse` for the genesis block, with an MMR path and chain length.
fn genesis_header_response() -> (miden_client::block::BlockHeader, Vec<u8>) {
    let genesis = MockChain::new().genesis_block_header();
    let mut header = Vec::new();
    proto::blockchain::BlockHeader::from(&genesis).encode(&mut header).unwrap();
    let mut response = ld(0x0a, &header);
    response.extend(ld(0x12, &[])); // mmr_path: an empty Merkle path
    response.push(0x1d); // chain_length, fixed32
    response.extend_from_slice(&1_u32.to_le_bytes());
    (genesis, response)
}

#[tokio::test]
async fn block_header_with_proof_returns_the_mmr_proof_the_node_sent() {
    let (genesis, response) = genesis_header_response();
    let (rpc, server) = serve(move |_| response.clone()).await;
    let result = rpc.get_block_header_with_proof(0).await.unwrap();
    server.abort();

    assert_eq!(result.header().commitment().to_hex(), genesis.commitment().to_hex());
    let proof = result.mmr_proof();
    assert_eq!(proof.leaf().to_hex(), genesis.commitment().to_hex());
    assert_eq!((proof.position(), proof.forest(), proof.peak_index()), (0, 1, 0));
    assert_eq!(proof.merkle_path().depth(), 0);
}

#[tokio::test]
async fn nullifier_commit_heights_match_full_nullifiers_and_omit_unspent_ones() {
    let (_, header_response) = genesis_header_response();
    let spent = miden_client::Word::from([1_u32, 2, 3, 4]);
    // Same 16-bit prefix as `spent`, so the node returns it for both lookups.
    let unspent = miden_client::Word::from([5_u32, 6, 7, 4]);
    let word: Vec<u8> = [1_u64, 2, 3, 4].iter().flat_map(|felt| felt.to_le_bytes()).collect();
    let mut update = ld(0x0a, &ld(0x0a, &word)); // NullifierUpdate.nullifier
    update.push(0x15); // block_num, fixed32
    update.extend_from_slice(&0_u32.to_le_bytes());
    let mut page = ld(0x0a, &[0x0d, 0, 0, 0, 0, 0x15, 0, 0, 0, 0]); // chain_tip 0, block_num 0
    page.extend(ld(0x12, &update));

    let (rpc, server) = serve(move |path| {
        if path.ends_with("/GetBlockHeaderByNumber") {
            header_response.clone()
        } else {
            assert!(path.ends_with("/SyncNullifiers"), "unexpected RPC path: {path}");
            page.clone()
        }
    })
    .await;
    rpc.inner.set_rpc_limits(Default::default()).await;
    let updates = rpc
        .get_nullifier_commit_heights(vec![Word::from(&spent), Word::from(&unspent)], 0)
        .await
        .unwrap();
    server.abort();

    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].nullifier().to_hex(), Word::from(&spent).to_hex());
    assert_eq!(updates[0].block_num(), 0);
}
