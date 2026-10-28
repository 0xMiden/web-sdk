use alloc::collections::{BTreeMap, VecDeque};

use miden_client::Word as NativeWord;
use miden_client::account::{
    Account,
    AccountHeader,
    StorageMap,
    StorageMapKey,
    StorageSlot,
    StorageSlotContent,
    StorageSlotName,
};
use miden_client::asset::{Asset, AssetCallbackFlag, FungibleAsset};
use miden_client::rpc::generated::rpc as proto;
use miden_client::testing::{Auth, MockChainBuilder};
use miden_client::utils::Serializable;
use miden_objects::prost::Message;
use tokio::sync::mpsc;

use super::*;

/// Serve wire responses while keeping the real transport, pagination and account conversion.
async fn account_server(
    responses: Vec<(&'static str, Vec<u8>)>,
) -> (
    RpcClient,
    mpsc::UnboundedReceiver<(String, Vec<u8>)>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (requests_tx, requests_rx) = mpsc::unbounded_channel();
    let mut replies: BTreeMap<_, VecDeque<_>> = BTreeMap::new();
    for (path, message) in responses {
        replies.entry(path).or_default().push_back(message);
    }
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut connection = h2::server::handshake(socket).await.unwrap();
        while let Some(request) = connection.accept().await {
            let (request, mut respond) = request.unwrap();
            let path = request.uri().path().to_owned();
            let message = replies
                .iter_mut()
                .find(|(suffix, _)| path.ends_with(**suffix))
                .and_then(|(_, pages)| pages.pop_front())
                .expect("unexpected extra RPC call");
            let requests_tx = requests_tx.clone();
            tokio::spawn(async move {
                let mut body = request.into_body();
                let mut bytes = Vec::new();
                while let Some(chunk) = body.data().await {
                    let chunk = chunk.unwrap();
                    body.flow_control().release_capacity(chunk.len()).unwrap();
                    bytes.extend_from_slice(&chunk);
                }
                requests_tx.send((path, bytes[5..].to_vec())).unwrap();
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
            });
        }
    });
    (RpcClient::new(Endpoint::new(endpoint).unwrap()).unwrap(), requests_rx, server)
}

fn account_fixture(
    oversize_maps: bool,
    oversize_vault: bool,
) -> (Account, proto::GetAccountResponse) {
    use proto::account_storage_details::AccountStorageMapDetails;
    use proto::account_storage_details::account_storage_map_details::all_map_entries::StorageMapEntry;
    use proto::account_storage_details::account_storage_map_details::{AllMapEntries, Result};

    let slots = [("test::large", 2), ("test::inline", 1)].map(|(name, count)| {
        let map = StorageMap::with_entries((1u32..count + 1).map(|i| {
            (StorageMapKey::new(NativeWord::from([i; 4])), NativeWord::from([i * 10; 4]))
        }))
        .unwrap();
        StorageSlot::with_map(StorageSlotName::new(name).unwrap(), map)
    });
    let mut builder = MockChainBuilder::new();
    let faucet_id =
        miden_client::account::AccountId::from_hex("0xc6da5c4573a3731151114a1aa8fe8e").unwrap();
    let asset = Asset::from(FungibleAsset::new(faucet_id, 100).unwrap());
    let account = builder
        .add_existing_mock_account_with_storage_and_assets(Auth::IncrNonce, slots, [asset])
        .unwrap();
    let chain = builder.build().unwrap();
    let map_details = account
        .storage()
        .slots()
        .iter()
        .filter_map(|slot| {
            let StorageSlotContent::Map(map) = slot.content() else {
                return None;
            };
            let name = slot.name();
            let entries = map
                .entries()
                .map(|(key, value)| StorageMapEntry {
                    key: Some(NativeWord::from(*key).into()),
                    value: Some((*value).into()),
                })
                .collect();
            Some(AccountStorageMapDetails {
                slot_name: name.to_string(),
                result: Some(if oversize_maps && name.as_str() == "test::large" {
                    Result::TooManyEntries(true)
                } else {
                    Result::AllEntries(AllMapEntries { entries })
                }),
            })
        })
        .collect();
    let response = proto::GetAccountResponse {
        block_num: Some(BlockNumber::from(12).into()),
        witness: Some(chain.account_tree().open(account.id()).into()),
        details: Some(proto::get_account_response::AccountDetails {
            header: Some(AccountHeader::from(&account).into()),
            storage_details: Some(proto::AccountStorageDetails {
                header: Some(account.storage().to_header().into()),
                map_details,
            }),
            code: Some(account.code().into()),
            vault_details: Some(proto::AccountVaultDetails {
                too_many_assets: oversize_vault,
                assets: if oversize_vault { vec![] } else { vec![asset.into()] },
            }),
        }),
    };
    (account, response)
}

fn map_page(block_num: u32, entries: &[(u32, u32)]) -> Vec<u8> {
    proto::SyncAccountStorageMapsResponse {
        // The tip advances past the account snapshot; pagination must remain bounded to 12.
        pagination_info: Some(proto::PaginationInfo { chain_tip: 99, block_num }),
        updates: entries
            .iter()
            .map(|&(key, value)| proto::StorageMapUpdate {
                block_num,
                slot_name: "test::large".into(),
                key: Some(NativeWord::from([key; 4]).into()),
                value: Some(NativeWord::from([value; 4]).into()),
            })
            .collect(),
    }
    .encode_to_vec()
}

fn vault_page(block_num: u32, asset: Asset) -> Vec<u8> {
    proto::SyncAccountVaultResponse {
        pagination_info: Some(proto::PaginationInfo { chain_tip: 99, block_num }),
        updates: vec![proto::AccountVaultUpdate {
            block_num,
            vault_key: Some(NativeWord::from(asset.id()).into()),
            asset: Some(asset.into()),
        }],
    }
    .encode_to_vec()
}

#[tokio::test]
async fn account_details_reconstruct_oversized_state_at_the_proof_block() {
    for (oversize_maps, oversize_vault) in
        [(false, false), (true, false), (false, true), (true, true)]
    {
        let (expected, proof) = account_fixture(oversize_maps, oversize_vault);
        let mut responses = vec![("/GetAccount", proof.encode_to_vec())];
        if oversize_vault {
            let asset = expected.vault().assets().next().unwrap();
            let old_asset = FungibleAsset::new(asset.id().faucet_id(), 1).unwrap().into();
            responses.extend([
                ("/SyncAccountVault", vault_page(5, old_asset)),
                ("/SyncAccountVault", vault_page(12, asset)),
            ]);
        }
        if oversize_maps {
            responses.extend([
                ("/SyncAccountStorageMaps", map_page(5, &[(1, 1), (3, 30)])),
                ("/SyncAccountStorageMaps", map_page(12, &[(1, 10), (2, 20), (3, 0)])),
            ]);
        }
        let (rpc, mut requests, server) = account_server(responses).await;
        let result = rpc.get_account_details(&expected.id().into()).await;
        server.abort();
        let fetched = result.unwrap();
        assert_eq!(miden_client::account::AccountId::from(fetched.account_id()), expected.id());
        assert_eq!(fetched.commitment().to_hex(), expected.to_commitment().to_hex());
        assert_eq!(fetched.last_block_num(), 12);
        assert_eq!(Account::from(fetched.account().unwrap()).to_bytes(), expected.to_bytes());
        assert!(fetched.is_public());
        assert!(requests.try_recv().unwrap().0.ends_with("/GetAccount"));
        let remaining: Vec<_> = std::iter::from_fn(|| requests.try_recv().ok()).collect();
        for (endpoint, oversized) in [
            ("/SyncAccountVault", oversize_vault),
            ("/SyncAccountStorageMaps", oversize_maps),
        ] {
            let pages: Vec<_> =
                remaining.iter().filter(|(path, _)| path.ends_with(endpoint)).collect();
            assert_eq!(pages.len(), if oversized { 2 } else { 0 });
            for ((_, bytes), start) in pages.into_iter().zip([0, 6]) {
                let (range, account_id) = if endpoint == "/SyncAccountVault" {
                    let request = proto::SyncAccountVaultRequest::decode(bytes.as_slice()).unwrap();
                    (request.block_range, request.account_id)
                } else {
                    let request =
                        proto::SyncAccountStorageMapsRequest::decode(bytes.as_slice()).unwrap();
                    (request.block_range, request.account_id)
                };
                assert_eq!(range.unwrap(), proto::BlockRange { block_from: start, block_to: 12 });
                assert_eq!(account_id.unwrap(), expected.id().into());
            }
        }
    }
}

#[tokio::test]
async fn account_details_reject_a_failed_storage_page() {
    let (expected, proof) = account_fixture(true, false);
    let (rpc, _requests, server) = account_server(vec![
        ("/GetAccount", proof.encode_to_vec()),
        ("/SyncAccountStorageMaps", map_page(5, &[(1, 1)])),
        // A successful gRPC response missing pagination metadata is not a complete page.
        (
            "/SyncAccountStorageMaps",
            proto::SyncAccountStorageMapsResponse::default().encode_to_vec(),
        ),
    ])
    .await;
    let result = rpc.get_account_details(&expected.id().into()).await;
    server.abort();
    let error = result.err().expect("a failed page must not return a partial account");
    assert!(
        error.reason.contains("failed to fetch account storage maps"),
        "{}",
        error.reason
    );
    assert!(error.reason.contains("pagination_info"), "{}", error.reason);
}

#[tokio::test]
async fn account_details_reject_when_pagination_stops_before_the_proof_block() {
    for (oversize_maps, oversize_vault) in [(true, false), (false, true)] {
        let (expected, proof) = account_fixture(oversize_maps, oversize_vault);
        let (endpoint, page) = if oversize_maps {
            let mut page =
                proto::SyncAccountStorageMapsResponse::decode(map_page(5, &[(1, 1)]).as_slice())
                    .unwrap();
            page.pagination_info = Some(proto::PaginationInfo { chain_tip: 5, block_num: 5 });
            ("/SyncAccountStorageMaps", page.encode_to_vec())
        } else {
            let asset = expected.vault().assets().next().unwrap();
            let old_asset = FungibleAsset::new(asset.id().faucet_id(), 1).unwrap().into();
            let mut page =
                proto::SyncAccountVaultResponse::decode(vault_page(5, old_asset).as_slice())
                    .unwrap();
            page.pagination_info = Some(proto::PaginationInfo { chain_tip: 5, block_num: 5 });
            ("/SyncAccountVault", page.encode_to_vec())
        };
        let (rpc, mut requests, server) =
            account_server(vec![("/GetAccount", proof.encode_to_vec()), (endpoint, page)]).await;
        let result = rpc.get_account_details(&expected.id().into()).await;
        server.abort();
        let error = result.err().expect("incomplete state must not return an account");
        assert!(
            error
                .reason
                .contains("reconstructed account commitment does not match the account proof")
        );
        assert!(requests.try_recv().unwrap().0.ends_with("/GetAccount"));
        let (path, bytes) = requests.try_recv().unwrap();
        assert!(path.ends_with(endpoint));
        let range = if oversize_maps {
            proto::SyncAccountStorageMapsRequest::decode(bytes.as_slice())
                .unwrap()
                .block_range
        } else {
            proto::SyncAccountVaultRequest::decode(bytes.as_slice()).unwrap().block_range
        };
        assert_eq!(range.unwrap().block_to, 12);
        assert!(requests.try_recv().is_err());
    }
}

#[tokio::test]
async fn private_account_details_preserve_metadata_without_fetching_state() {
    use miden_client::account::{AccountId as NativeAccountId, AccountIdVersion, AccountType};

    let (public_account, _) = account_fixture(false, false);
    let account = Account::new_existing(
        NativeAccountId::dummy(
            [7; 15],
            AccountIdVersion::Version1,
            AccountType::Private,
            AssetCallbackFlag::Disabled,
        ),
        public_account.vault().clone(),
        public_account.storage().clone(),
        public_account.code().clone(),
        public_account.nonce(),
    );
    let chain = MockChainBuilder::with_accounts([account.clone()]).unwrap().build().unwrap();
    let proof = proto::GetAccountResponse {
        block_num: Some(BlockNumber::from(12).into()),
        witness: Some(chain.account_tree().open(account.id()).into()),
        details: None,
    };
    let (rpc, mut requests, server) =
        account_server(vec![("/GetAccount", proof.encode_to_vec())]).await;
    let result = rpc.get_account_details(&account.id().into()).await;
    server.abort();
    let fetched = result.unwrap();
    assert!(fetched.is_private());
    assert!(fetched.account().is_none());
    assert_eq!(fetched.commitment().to_hex(), account.to_commitment().to_hex());
    assert_eq!(fetched.last_block_num(), 12);
    assert!(requests.try_recv().unwrap().0.ends_with("/GetAccount"));
    assert!(requests.try_recv().is_err());
}
