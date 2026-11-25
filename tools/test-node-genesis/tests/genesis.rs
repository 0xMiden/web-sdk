use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use miden_objects::account_file::AccountFile;
use miden_protocol::ONE;
use miden_protocol::asset::AssetId;
use miden_standards::account::fees::FeePolicyManager;
use test_node_genesis::agglayer::{
    AGGLAYER_FAUCET_ACCOUNT_FILE,
    BRIDGE_ACCOUNT_FILE,
    BRIDGE_ADMIN_ACCOUNT_FILE,
    GER_MANAGER_ACCOUNT_FILE,
};
use test_node_genesis::{GENESIS_FAUCET_FILE, NATIVE_FAUCET_FILE, write_genesis_config};

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(prefix: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).expect("temp dir should be created");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[test]
fn native_faucet_fee_asset_slot_points_to_self() {
    let dir = TempDir::new("test-node-genesis-native-faucet");
    write_genesis_config(dir.path(), 1).expect("genesis config generation should succeed");

    let native_faucet = AccountFile::read(dir.path().join(NATIVE_FAUCET_FILE))
        .expect("native faucet account file should deserialize");
    let account = native_faucet.account();
    let slot_value = account
        .storage()
        .get_item(FeePolicyManager::fee_asset_id_slot())
        .expect("native faucet should contain FeePolicyManager fee_asset_id_slot");

    assert_eq!(account.nonce(), ONE);
    assert_eq!(slot_value, AssetId::new_fungible(account.id()).to_word());

    let tst_faucet = AccountFile::read(dir.path().join(GENESIS_FAUCET_FILE))
        .expect("TST faucet account file should deserialize");
    assert_eq!(tst_faucet.account().nonce(), ONE);
    assert_eq!(tst_faucet.auth_secret_keys().len(), 1);

    for (file, expected_keys) in [
        (BRIDGE_ADMIN_ACCOUNT_FILE, 1usize),
        (GER_MANAGER_ACCOUNT_FILE, 1usize),
        (BRIDGE_ACCOUNT_FILE, 0usize),
        (AGGLAYER_FAUCET_ACCOUNT_FILE, 0usize),
    ] {
        let af = AccountFile::read(dir.path().join(file))
            .unwrap_or_else(|err| panic!("failed to read {file}: {err}"));
        assert_eq!(af.account().nonce(), ONE, "{file} should have nonce ONE");
        assert_eq!(af.auth_secret_keys().len(), expected_keys, "{file} key count mismatch");
    }

    let first_test_faucet = AccountFile::read(dir.path().join("test_account_0000.mac"))
        .expect("test_account_0000.mac should deserialize");
    assert_eq!(first_test_faucet.account().nonce(), ONE);
    assert!(first_test_faucet.account().seed().is_none());

    let many_assets_account = AccountFile::read(dir.path().join("test_account_1001.mac"))
        .expect("test_account_1001.mac should deserialize");
    assert_eq!(many_assets_account.account().id().to_hex(), "0x0a0a0a0a0a0a0a110a0a0a0a0a0a0a");
    assert_eq!(many_assets_account.account().nonce(), ONE);
}
