use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use miden_objects::account_file::AccountFile;
use miden_protocol::ONE;
use miden_protocol::asset::AssetId;
use miden_standards::account::fees::FeePolicyManager;
use test_node_genesis::{NATIVE_FAUCET_FILE, write_genesis_config};

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
}
