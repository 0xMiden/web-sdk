use idxdb_store::IdxdbStore;
use miden_client::account::{
    Account,
    AccountCode,
    AccountHeader,
    AccountId as NativeAccountId,
    AccountPatch,
    AccountStorage,
    AccountVaultPatch,
    Address,
    StorageMap,
    StorageMapKey,
    StorageSlot,
    StorageSlotName,
};
use miden_client::assembly::Assembler as NativeAssembler;
use miden_client::asset::{Asset, AssetVault, FungibleAsset};
use miden_client::note::NoteUpdateTracker;
use miden_client::store::{ClientAccountType, Store};
use miden_client::testing::MockChain;
use miden_client::testing::account_id::{
    ACCOUNT_ID_FEE_FAUCET,
    ACCOUNT_ID_PRIVATE_SENDER,
    ACCOUNT_ID_PUBLIC_FUNGIBLE_FAUCET,
    ACCOUNT_ID_REGULAR_PRIVATE_ACCOUNT_UPDATABLE_CODE,
};
use miden_client::transaction::{
    ExecutedTransaction,
    InputNotes,
    RawOutputNotes,
    TransactionInputs,
    TransactionStoreUpdate,
};
use miden_client::vm::TargetType as NativeTargetType;
use miden_client::{Felt, Serializable, Word};
use miden_protocol::transaction::{TransactionMeasurements, TransactionOutputs};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::js_sys::Uint8Array;

use crate::models::account_id::AccountId;

#[wasm_bindgen]
pub struct TestUtils;

#[wasm_bindgen]
impl TestUtils {
    #[wasm_bindgen(js_name = "createMockAccountId")]
    pub fn create_mock_account_id() -> AccountId {
        let native_account_id: NativeAccountId =
            ACCOUNT_ID_REGULAR_PRIVATE_ACCOUNT_UPDATABLE_CODE.try_into().unwrap();
        native_account_id.into()
    }

    #[wasm_bindgen(js_name = "createMockSerializedLibraryPackage")]
    pub fn create_mock_serialized_library_package() -> Uint8Array {
        pub const CODE: &str = "
            namespace miden::testing::package_tests

            pub proc foo
                push.1.2 mul
            end

            pub proc bar
                push.1.2 add
            end
        ";

        let package = NativeAssembler::default()
            .assemble_library("test_package_no_metadata", CODE, None::<&str>)
            .unwrap();

        let bytes: Vec<u8> = package.to_bytes();
        Uint8Array::from(bytes.as_slice())
    }

    #[wasm_bindgen(js_name = "createMockSerializedProgramPackage")]
    pub fn create_mock_serialized_program_package() -> Uint8Array {
        pub const CODE: &str = "
            namespace miden::testing::note_script

            @note_script
            pub proc main
                # This code computes 1001st Fibonacci number
                repeat.1000
                    swap dup.1 add
                end
            end
        ";

        let mut package = NativeAssembler::default()
            .assemble_library("test_note_script_package", CODE, None::<&str>)
            .unwrap();
        package.kind = NativeTargetType::Note;

        let bytes: Vec<u8> = package.to_bytes();
        Uint8Array::from(bytes.as_slice())
    }
}

#[wasm_bindgen]
pub struct AccountForestFixture {
    writer: IdxdbStore,
    reader: IdxdbStore,
    current: Account,
}

#[wasm_bindgen]
impl AccountForestFixture {
    pub async fn create(database_name: String) -> Result<AccountForestFixture, JsValue> {
        let writer = IdxdbStore::new(database_name.clone()).await?;
        let id = ACCOUNT_ID_REGULAR_PRIVATE_ACCOUNT_UPDATABLE_CODE.try_into().unwrap();
        let current = Account::new_existing(
            id,
            AssetVault::new(&[Self::asset(false, 1000)]).unwrap(),
            AccountStorage::new(vec![StorageSlot::with_map(Self::slot(), StorageMap::new())])
                .unwrap(),
            AccountCode::mock(),
            Felt::ONE,
        );
        Store::insert_account(&writer, &current, Address::new(id), ClientAccountType::Native)
            .await
            .map_err(Self::error)?;
        let reader = IdxdbStore::new(database_name).await?;
        let mut fixture = Self { writer, reader, current };
        fixture.adopt_shared_state().await?;
        Ok(fixture)
    }

    #[wasm_bindgen(js_name = accountId)]
    pub fn account_id(&self) -> String {
        self.current.id().to_string()
    }

    #[wasm_bindgen(js_name = readAccount)]
    pub async fn read_account(&self) -> Result<String, JsValue> {
        let record = Store::get_account(&self.reader, self.current.id())
            .await
            .map_err(Self::error)?
            .unwrap();
        let account = Account::try_from(record).map_err(Self::error)?;
        Ok(account.to_commitment().to_string())
    }

    #[wasm_bindgen(js_name = readAsset)]
    pub async fn read_asset(&self, other: bool) -> Result<u64, JsValue> {
        let (asset, _) =
            Store::get_account_asset(&self.reader, self.current.id(), Self::asset(other, 1).id())
                .await
                .map_err(Self::error)?
                .unwrap();
        Ok(u64::from(asset.unwrap_fungible().amount()))
    }

    #[wasm_bindgen(js_name = readMap)]
    pub async fn read_map(&self) -> Result<String, JsValue> {
        let (value, _) = Store::get_account_map_item(
            &self.reader,
            self.current.id(),
            Self::slot(),
            StorageMapKey::new(Self::key()),
        )
        .await
        .map_err(Self::error)?;
        Ok(value.to_string())
    }

    #[wasm_bindgen(js_name = adoptSharedState)]
    pub async fn adopt_shared_state(&mut self) -> Result<(), JsValue> {
        let storage = AccountStorage::new(vec![StorageSlot::with_map(
            Self::slot(),
            StorageMap::with_entries([(StorageMapKey::new(Self::key()), Self::value())]).unwrap(),
        )])
        .unwrap();
        self.current = Account::new_existing(
            self.current.id(),
            AssetVault::new(&[Self::asset(false, 1000), Self::asset(true, 777)]).unwrap(),
            storage,
            self.current.code().clone(),
            Felt::new(2).unwrap(),
        );
        Store::update_account(&self.writer, &self.current).await.map_err(Self::error)
    }

    #[wasm_bindgen(js_name = adoptFinalState)]
    pub async fn adopt_final_state(&self, later: bool) -> Result<(), JsValue> {
        let (final_account, _) = Self::update(&self.current, 867);
        let final_account = if later {
            Self::update(&final_account, 734).0
        } else {
            final_account
        };
        Store::update_account(&self.writer, &final_account).await.map_err(Self::error)
    }

    pub async fn apply(&self, batch: bool) -> Result<(), JsValue> {
        let (first, first_update) = Self::update(&self.current, 867);
        if batch {
            let (_, second_update) = Self::update(&first, 734);
            self.reader
                .apply_transaction_batch_atomic(vec![first_update, second_update])
                .await
                .map_err(Self::error)
        } else {
            self.reader.apply_transaction(first_update).await.map_err(Self::error)
        }
    }

    #[wasm_bindgen(js_name = applyDiscontinuousBatch)]
    pub async fn apply_discontinuous_batch(&self) -> Result<(), JsValue> {
        let (_, first) = Self::update(&self.current, 867);
        let (_, second) = Self::update(&self.current, 734);
        self.reader
            .apply_transaction_batch_atomic(vec![first, second])
            .await
            .map_err(Self::error)
    }

    #[wasm_bindgen(js_name = applyInvalidFinalRootBatch)]
    pub async fn apply_invalid_final_root_batch(&self) -> Result<(), JsValue> {
        let (first, first_update) = Self::update(&self.current, 867);
        let invalid_header = Self::update(&first, 600).0.to_header();
        let (_, second_update) = Self::update_with_header(&first, 734, Some(invalid_header));
        self.reader
            .apply_transaction_batch_atomic(vec![first_update, second_update])
            .await
            .map_err(Self::error)
    }

    #[wasm_bindgen(js_name = applyInterleavedBatch)]
    pub async fn apply_interleaved_batch(&self) -> Result<Vec<String>, JsValue> {
        let other = Account::new_existing(
            ACCOUNT_ID_PRIVATE_SENDER.try_into().unwrap(),
            AssetVault::new(&[Self::asset(false, 2000), Self::asset(true, 555)]).unwrap(),
            self.current.storage().clone(),
            self.current.code().clone(),
            self.current.nonce(),
        );
        Store::insert_account(
            &self.writer,
            &other,
            Address::new(other.id()),
            ClientAccountType::Native,
        )
        .await
        .map_err(Self::error)?;
        let (first, first_update) = Self::update(&self.current, 867);
        let (_, other_update) = Self::update(&other, 1867);
        let (_, second_update) = Self::update(&first, 734);
        self.reader
            .apply_transaction_batch_atomic(vec![first_update, other_update, second_update])
            .await
            .map_err(Self::error)?;
        let mut balances = Vec::new();
        for other_asset in [false, true] {
            let (asset, _) = Store::get_account_asset(
                &self.reader,
                other.id(),
                Self::asset(other_asset, 1).id(),
            )
            .await
            .map_err(Self::error)?
            .unwrap();
            balances.push(u64::from(asset.unwrap_fungible().amount()).to_string());
        }
        Ok(balances)
    }
}

impl AccountForestFixture {
    fn error(error: impl core::fmt::Debug) -> JsValue {
        JsValue::from_str(&format!("{error:?}"))
    }

    fn slot() -> StorageSlotName {
        StorageSlotName::new("test::forest::map").unwrap()
    }
    fn key() -> Word {
        Word::from([1_u32, 2, 3, 4])
    }
    fn value() -> Word {
        Word::from([5_u32, 6, 7, 8])
    }

    fn asset(other: bool, amount: u64) -> Asset {
        let id = if other {
            ACCOUNT_ID_PUBLIC_FUNGIBLE_FAUCET
        } else {
            ACCOUNT_ID_FEE_FAUCET
        };
        FungibleAsset::new(id.try_into().unwrap(), amount).unwrap().into()
    }

    fn update(initial: &Account, fee_balance: u64) -> (Account, TransactionStoreUpdate) {
        Self::update_with_header(initial, fee_balance, None)
    }

    fn update_with_header(
        initial: &Account,
        fee_balance: u64,
        final_header: Option<AccountHeader>,
    ) -> (Account, TransactionStoreUpdate) {
        let mut vault = AccountVaultPatch::default();
        vault.insert_asset(Self::asset(false, fee_balance));
        let patch = AccountPatch::new(
            initial.id(),
            Default::default(),
            vault,
            Default::default(),
            Some(initial.nonce() + Felt::ONE),
        )
        .unwrap();
        let mut final_account = initial.clone();
        final_account.apply_patch(&patch).unwrap();
        let chain = MockChain::new();
        let inputs = TransactionInputs::new(
            initial.into(),
            chain.latest_block_header(),
            chain.protocol_config().clone(),
            chain.latest_partial_blockchain(),
            InputNotes::new(vec![]).unwrap(),
        )
        .unwrap();
        let outputs = TransactionOutputs::new(
            final_header.unwrap_or_else(|| final_account.to_header()),
            patch.to_commitment(),
            RawOutputNotes::new(vec![]).unwrap(),
            100_u32.into(),
        );
        let tx = ExecutedTransaction::new(
            inputs,
            outputs,
            patch,
            TransactionMeasurements {
                prologue: 1,
                notes_processing: 0,
                note_execution: vec![],
                tx_script_processing: 0,
                epilogue: 0,
                auth_procedure: 0,
            },
        );
        (
            final_account,
            TransactionStoreUpdate::new(
                tx,
                0_u32.into(),
                NoteUpdateTracker::default(),
                vec![],
                vec![],
            ),
        )
    }
}
