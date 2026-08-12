use js_export_macro::js_export;
use miden_client::Word as NativeWord;
use miden_client::account::component::NetworkAccount;
use miden_client::account::{
    Account as NativeAccount,
    AccountComponentInterface,
    AccountComponentInterfaceExt,
};
use miden_client::testing::standards::account_interface::get_public_keys_from_account;

use crate::models::account_code::AccountCode;
use crate::models::account_id::AccountId;
use crate::models::account_storage::AccountStorage;
use crate::models::asset_vault::AssetVault;
use crate::models::felt::Felt;
use crate::models::word::Word;
use crate::platform::{JsBytes, JsErr, from_str_err};
use crate::utils::{deserialize_from_bytes, serialize_to_bytes};

/// An account which can store assets and define rules for manipulating them.
///
/// An account consists of the following components:
/// - Account ID, which uniquely identifies the account and also defines basic properties of the
///   account.
/// - Account vault, which stores assets owned by the account.
/// - Account storage, which is a key-value map (both keys and values are words) used to store
///   arbitrary user-defined data.
/// - Account code, which is a set of Miden VM programs defining the public interface of the
///   account.
/// - Account nonce, a value which is incremented whenever account state is updated.
///
/// Out of the above components account ID is always immutable (once defined it can never be
/// changed). Other components may be mutated throughout the lifetime of the account. However,
/// account state can be changed only by invoking one of account interface methods.
///
/// The recommended way to build an account is through an `AccountBuilder`, which can be
/// instantiated directly from a 32-byte seed.
#[derive(Clone)]
#[js_export]
pub struct Account(NativeAccount);

#[js_export]
impl Account {
    /// Returns the account identifier.
    pub fn id(&self) -> AccountId {
        self.0.id().into()
    }

    /// Returns the commitment to the account header, storage, and code.
    pub fn to_commitment(&self) -> Word {
        self.0.to_commitment().into()
    }

    /// Returns the account nonce, which is incremented on every state update.
    pub fn nonce(&self) -> Felt {
        self.0.nonce().into()
    }

    /// Returns the vault commitment for this account.
    pub fn vault(&self) -> AssetVault {
        self.0.vault().into()
    }

    /// Returns the account storage commitment.
    pub fn storage(&self) -> AccountStorage {
        self.0.storage().into()
    }

    /// Returns the code commitment for this account.
    pub fn code(&self) -> AccountCode {
        self.0.code().into()
    }

    // Faucet-ness is encoded in the account's code, so it is derived from the
    // account's component interface rather than from its `AccountId`.

    /// Returns true if the account exposes a fungible-faucet interface.
    #[js_export(js_name = "isFaucet")]
    pub fn is_faucet(&self) -> bool {
        self.component_interfaces().contains(&AccountComponentInterface::FungibleFaucet)
    }

    /// Returns true if the account is a regular (non-faucet) account.
    #[js_export(js_name = "isRegularAccount")]
    pub fn is_regular_account(&self) -> bool {
        !self.is_faucet()
    }

    /// Returns true if the account exposes public storage.
    #[js_export(js_name = "isPublic")]
    pub fn is_public(&self) -> bool {
        self.0.is_public()
    }

    /// Returns true if the account storage is private.
    #[js_export(js_name = "isPrivate")]
    pub fn is_private(&self) -> bool {
        self.0.is_private()
    }

    /// Returns true if the account has not yet been committed to the chain.
    #[js_export(js_name = "isNew")]
    pub fn is_new(&self) -> bool {
        self.0.is_new()
    }

    /// Returns true if this is a network account.
    ///
    /// A network account is a public account whose storage
    /// carries the standardized network-account note-script allowlist slot.
    #[js_export(js_name = "isNetworkAccount")]
    pub fn is_network_account(&self) -> bool {
        NetworkAccount::new(self.0.clone()).is_ok()
    }

    /// Returns the note-script roots this network account is allowed to
    /// consume, or `undefined` if this is not a network account.
    #[js_export(js_name = "networkNoteAllowlist")]
    pub fn network_note_allowlist(&self) -> Option<Vec<Word>> {
        NetworkAccount::new(self.0.clone()).ok().map(|network_account| {
            network_account
                .allowed_notes()
                .allowed_script_roots()
                .iter()
                .map(|root| Word::from(NativeWord::from(*root)))
                .collect()
        })
    }

    /// Serializes the account into bytes.
    pub fn serialize(&self) -> JsBytes {
        serialize_to_bytes(&self.0)
    }

    /// Restores an account from its serialized bytes.
    pub fn deserialize(bytes: JsBytes) -> Result<Account, JsErr> {
        deserialize_from_bytes::<NativeAccount>(&bytes).map(Account)
    }

    /// Returns the public key commitments derived from the account's authentication scheme.
    ///
    /// Reads the keys out of account state, so it answers "who may authorize this account" —
    /// for a multisig that is every approver, including keys this client does not hold. For
    /// "which keys do I hold for this account", use `client.keystore.getCommitments(accountId)`
    /// instead.
    ///
    /// Throws when the account's auth component is not one of the bundled standard components.
    /// Third-party auth components define their own key storage layout and cannot be decoded
    /// here; read their keys through the package that defines the component.
    #[js_export(js_name = "getPublicKeyCommitments")]
    pub fn get_public_key_commitments(&self) -> Result<Vec<Word>, JsErr> {
        let auth_components = self
            .component_interfaces()
            .into_iter()
            .filter(AccountComponentInterface::is_auth_component)
            .count();

        // `get_public_keys_from_account` classifies via `AccountInterface::from_account`, which
        // asserts on exactly one auth component. Reject those accounts here so an unrecognized
        // auth component surfaces as an error instead of a panic or an empty list.
        if auth_components != 1 {
            return Err(from_str_err(&format!(
                "expected exactly one standard auth component, found {auth_components}: cannot \
                 derive public key commitments from this account's state"
            )));
        }

        Ok(get_public_keys_from_account(&self.0).into_iter().map(Into::into).collect())
    }
}

impl Account {
    /// Classifies the account's procedures into component interfaces, bucketing anything
    /// unrecognized as `Custom`.
    ///
    /// Deliberately not `AccountInterface::from_account`, which panics unless the account
    /// installs exactly one auth component matching a bundled standard template.
    fn component_interfaces(&self) -> Vec<AccountComponentInterface> {
        AccountComponentInterface::from_procedures(self.0.code().procedures())
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativeAccount> for Account {
    fn from(native_account: NativeAccount) -> Self {
        Account(native_account)
    }
}

impl From<&NativeAccount> for Account {
    fn from(native_account: &NativeAccount) -> Self {
        Account(native_account.clone())
    }
}

impl From<Account> for NativeAccount {
    fn from(account: Account) -> Self {
        account.0
    }
}

impl From<&Account> for NativeAccount {
    fn from(account: &Account) -> Self {
        account.0.clone()
    }
}

impl_napi_from_value!(Account);
