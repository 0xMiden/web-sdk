use js_export_macro::js_export;
use miden_client::Word as NativeWord;
use miden_client::account::component::NetworkAccount;
use miden_client::account::{
    Account as NativeAccount,
    AccountComponentInterface,
    AccountComponentInterfaceExt,
    StorageSlot,
    StorageSlotContent,
};
use miden_client::auth::{AuthGuardedMultisig, AuthMultisig, AuthMultisigSmart};
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
    // account's component interface rather than from its `AccountId`. It uses
    // `from_procedures`, not `AccountInterface`, whose constructor asserts on exactly
    // one auth component and traps under `panic = "abort"`.

    /// Returns true if the account exposes a fungible-faucet interface.
    #[js_export(js_name = "isFaucet")]
    pub fn is_faucet(&self) -> bool {
        AccountComponentInterface::from_procedures(self.0.code().procedures())
            .contains(&AccountComponentInterface::FungibleFaucet)
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
    /// Reads the keys out of account state, so it answers "who may authorize this account": for
    /// a multisig that is every approver, including keys this client does not hold. For "which
    /// keys do I hold for this account", use `client.keystore.getCommitments(accountId)` instead.
    ///
    /// Throws unless exactly one standard auth component bundled with this SDK owns the account's
    /// auth procedure. The causes, and what to do about each:
    /// - A custom auth component, which defines its own key storage layout: read its keys through
    ///   the package that defines it, or use `client.keystore.getCommitments(accountId)` for the
    ///   keys this client holds.
    /// - A standard component built from a different miden-standards revision: use an SDK version
    ///   that matches the revision the account was built with.
    /// - A standard component compiled through `AccountComponent.compile`, which links it
    ///   dynamically and so changes its procedure root: build it with the SDK's factory, such as
    ///   `createAuthGuardedMultisig`.
    ///
    /// Two kinds of standard auth component return `[]`: `NoAuth` and the network account hold no
    /// key, and the tx fee collector's key is not read here (the SDK cannot build such an
    /// account).
    ///
    /// Also throws when a multisig's threshold config declares more approvers than its approver
    /// key storage holds, which only a tampered account can do.
    #[js_export(js_name = "getPublicKeyCommitments")]
    pub fn get_public_key_commitments(&self) -> Result<Vec<Word>, JsErr> {
        let procedures = self.0.code().procedures();
        let components = AccountComponentInterface::from_procedures(procedures);
        let auth_components: Vec<&AccountComponentInterface> =
            components.iter().filter(|component| component.is_auth_component()).collect();

        // `from_procedures` removes every root a standard component claimed, so an auth procedure
        // root left in a `Custom` bucket belongs to no standard component, even when another
        // procedure matched one.
        let auth_root_unclaimed = procedures.first().is_none_or(|auth_root| {
            components.iter().any(|component| {
                matches!(
                    component,
                    AccountComponentInterface::Custom(roots) if roots.contains(auth_root)
                )
            })
        });
        let owned_by_one_standard_component = !auth_root_unclaimed
            && matches!(
                auth_components.as_slice(),
                [only] if !matches!(only, AccountComponentInterface::CustomAuth(_))
            );

        if !owned_by_one_standard_component {
            let found = if auth_components.is_empty() {
                "none".to_string()
            } else {
                auth_components
                    .iter()
                    .map(|component| component.name())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            return Err(from_str_err(&format!(
                "cannot derive public key commitments from account state: the account's auth \
                 procedure is not owned by exactly one standard auth component bundled with this \
                 SDK (auth components found: {found}). If it is a custom auth component, read its \
                 keys through the package that defines it, or use \
                 client.keystore.getCommitments(accountId) for the keys this client holds. If it \
                 is a standard component built from a different miden-standards revision, use an \
                 SDK version that matches it. If it is a standard component compiled through \
                 AccountComponent.compile, which links it dynamically, build it with the SDK's \
                 factory such as createAuthGuardedMultisig instead."
            )));
        }

        // `get_public_keys_from_account` looks up as many approver keys as the threshold config
        // declares, so a count above the stored entries would loop over keys that do not exist.
        let multisig_slots = match auth_components[0] {
            AccountComponentInterface::AuthMultisig => Some((
                AuthMultisig::threshold_config_slot(),
                AuthMultisig::approver_public_keys_slot(),
            )),
            AccountComponentInterface::AuthMultisigSmart => Some((
                AuthMultisigSmart::threshold_config_slot(),
                AuthMultisigSmart::approver_public_keys_slot(),
            )),
            AccountComponentInterface::AuthGuardedMultisig => Some((
                AuthGuardedMultisig::threshold_config_slot(),
                AuthGuardedMultisig::approver_public_keys_slot(),
            )),
            _ => None,
        };
        if let Some((config_slot, keys_slot)) = multisig_slots
            && let Ok(config) = self.0.storage().get_item(config_slot)
        {
            // Truncated exactly as the upstream loop bound is.
            #[allow(clippy::cast_possible_truncation)]
            let count = config[1].as_canonical_u64() as u32;
            let stored = match self.0.storage().get(keys_slot).map(StorageSlot::content) {
                Some(StorageSlotContent::Map(map)) => map.num_entries(),
                _ => 0,
            };
            if count as usize > stored {
                return Err(from_str_err(&format!(
                    "cannot derive public key commitments from account state: the multisig auth \
                     component declares {count} approvers but its approver key storage holds \
                     {stored} entries"
                )));
            }
        }

        // Exactly one auth component was classified, so the `AccountInterface` this builds
        // internally cannot assert.
        Ok(get_public_keys_from_account(&self.0).into_iter().map(Into::into).collect())
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
