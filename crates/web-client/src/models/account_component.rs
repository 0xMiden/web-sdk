use alloc::collections::BTreeSet;
use alloc::format;

use js_export_macro::js_export;
use miden_client::Word as NativeWord;
use miden_client::account::component::{
    AccountComponent as NativeAccountComponent,
    AccountComponentMetadata,
    AuthNetworkAccount,
    BasicConstantFeePolicy,
    FeePolicyManager,
};
use miden_client::account::{
    AccountComponentCode as NativeAccountComponentCode,
    StorageSlot as NativeStorageSlot,
};
use miden_client::assembly::MastNodeExt;
use miden_client::asset::AssetAmount;
use miden_client::auth::{
    Approver,
    AuthSchemeId as NativeAuthSchemeId,
    AuthSecretKey as NativeSecretKey,
    AuthSingleSig as NativeSingleSig,
    PublicKeyCommitment,
};
use miden_client::note::{FeeSponsorshipNote, NetworkAccountConfigNote, NoteScriptRoot};
use miden_client::transaction::{ExpirationTransactionScript, TransactionScriptRoot};
use miden_client::vm::Package as NativePackage;

use crate::js_error_with_context;
use crate::models::account_component_code::AccountComponentCode;
use crate::models::account_id::AccountId;
use crate::models::auth::AuthScheme;
use crate::models::auth_secret_key::AuthSecretKey;
use crate::models::library::Library;
use crate::models::miden_arrays::StorageSlotArray;
use crate::models::package::Package;
use crate::models::storage_slot::StorageSlot;
use crate::models::word::Word;
use crate::platform::{JsErr, from_str_err, js_u64_to_u64, u64_to_js_u64};

/// A note script a network account allows, together with the fee it charges to consume notes
/// running that script.
///
/// Passed to `AccountComponent.createNetworkAuthComponents`, where the roots form the account's
/// note-script allowlist and the amounts its fee schedule. Amounts are denominated in the
/// fungible asset of the fee faucet given to that same call.
#[derive(Clone)]
#[js_export]
pub struct NoteScriptFee {
    script_root: Word,
    amount: u64,
}

#[js_export]
impl NoteScriptFee {
    /// Prices consumption of notes whose script root is `scriptRoot` at `amount`.
    ///
    /// Obtain the root via `NoteScript.root()`. An amount of `0` is a valid price and is what an
    /// account that charges nothing for a note uses.
    #[js_export(constructor)]
    pub fn new(script_root: &Word, amount: JsU64) -> NoteScriptFee {
        NoteScriptFee {
            script_root: script_root.clone(),
            amount: js_u64_to_u64(amount),
        }
    }

    /// Returns the note script root this fee applies to.
    #[js_export(getter, js_name = "scriptRoot")]
    pub fn script_root(&self) -> Word {
        self.script_root.clone()
    }

    /// Returns the fee charged for the note script root.
    #[js_export(getter)]
    pub fn amount(&self) -> JsU64 {
        u64_to_js_u64(self.amount)
    }
}

/// Procedure digest paired with whether it is an auth procedure.
#[derive(Clone)]
#[js_export]
pub struct GetProceduresResultItem {
    digest: Word,
    is_auth: bool,
}

#[js_export]
impl GetProceduresResultItem {
    /// Returns the MAST root digest for the procedure.
    #[js_export(getter)]
    pub fn digest(&self) -> Word {
        self.digest.clone()
    }

    /// Returns true if the procedure is used for authentication.
    #[js_export(getter, js_name = "isAuth")]
    pub fn is_auth(&self) -> bool {
        self.is_auth
    }
}

impl From<(miden_client::account::AccountProcedureRoot, bool)> for GetProceduresResultItem {
    fn from(
        native_get_procedures_result_item: (miden_client::account::AccountProcedureRoot, bool),
    ) -> Self {
        let digest_word: NativeWord = native_get_procedures_result_item.0.into();
        Self {
            digest: digest_word.into(),
            is_auth: native_get_procedures_result_item.1,
        }
    }
}

#[js_export]
#[derive(Clone)]
pub struct AccountComponent(NativeAccountComponent);

#[js_export]
impl AccountComponent {
    /// Compiles account code with the given storage slots using the provided assembler.
    pub fn compile(
        account_code: AccountComponentCode,
        storage_slots: Vec<StorageSlot>,
    ) -> Result<AccountComponent, JsErr> {
        let native_slots: Vec<NativeStorageSlot> =
            storage_slots.into_iter().map(Into::into).collect();

        let native_account_code: NativeAccountComponentCode = account_code.into();

        NativeAccountComponent::new(
            native_account_code,
            native_slots,
            AccountComponentMetadata::new("custom"),
        )
        .map(AccountComponent)
        .map_err(|e| js_error_with_context(e, "Failed to compile account component"))
    }

    /// Returns the exact compiled code used by this component.
    ///
    /// Link this code when compiling scripts that invoke the component. Rebuilding a library from
    /// the original source can produce different procedure identities than the code installed on
    /// the account.
    #[js_export(js_name = "componentCode")]
    pub fn component_code(&self) -> AccountComponentCode {
        self.0.component_code().clone().into()
    }

    /// Marks the component as supporting all account types.
    ///
    /// The 0.15 protocol collapsed the per-account-type flag set on
    /// `AccountComponentMetadata::new` — every component now applies to every account type
    /// implicitly, so this method's job is to re-derive the metadata under the new
    /// (name-only) constructor while keeping the JS API surface stable.
    #[js_export(js_name = "withSupportsAllTypes")]
    pub fn with_supports_all_types(&self) -> Self {
        let code = self.0.component_code().clone();
        let slots = self.0.storage_slots().to_vec();
        let name = self.0.metadata().name();
        let metadata = AccountComponentMetadata::new(name);
        AccountComponent(
            NativeAccountComponent::new(code, slots, metadata)
                .expect("reconstructing component with updated metadata should not fail"),
        )
    }

    /// Returns the hex-encoded MAST root for a procedure by name.
    ///
    /// Matches by full path, relative path, or local name (after the last `::`).
    /// When matching by local name, if multiple procedures share the same local
    /// name across modules, the first match is returned.
    #[js_export(js_name = "getProcedureHash")]
    pub fn get_procedure_hash(&self, procedure_name: String) -> Result<String, JsErr> {
        let library = self.0.component_code().as_package();

        let get_proc_export = library
            .manifest
            .exports()
            .find(|export| {
                if export.as_procedure().is_none() {
                    return false;
                }
                let export_path = export.path();
                let path_str = export_path.as_ref().as_str();
                path_str == procedure_name.as_str()
                    || export_path.as_ref().to_relative().as_str() == procedure_name.as_str()
                    || path_str
                        .rsplit_once("::")
                        .is_some_and(|(_, local)| local == procedure_name.as_str())
            })
            .ok_or_else(|| {
                from_str_err(&format!(
                    "Procedure {procedure_name} not found in the account component library"
                ))
            })?;

        let get_proc_mast_id = library.get_export_node_id(get_proc_export.path());

        let digest_hex = library
            .mast_forest()
            .get_node_by_id(get_proc_mast_id)
            .ok_or_else(|| {
                from_str_err(&format!("Mast node for procedure {procedure_name} not found"))
            })?
            .digest()
            .to_hex();

        Ok(digest_hex)
    }

    /// Returns all procedures exported by this component.
    #[js_export(js_name = "getProcedures")]
    pub fn get_procedures(&self) -> Vec<GetProceduresResultItem> {
        self.0.procedures().map(Into::into).collect()
    }

    /// Builds an auth component from a secret key, inferring the auth scheme from the key type.
    #[js_export(js_name = "createAuthComponentFromSecretKey")]
    pub fn create_auth_component_from_secret_key(
        secret_key: &AuthSecretKey,
    ) -> Result<AccountComponent, JsErr> {
        let native_secret_key: NativeSecretKey = secret_key.into();
        let commitment = native_secret_key.public_key().to_commitment();

        let auth_scheme = match native_secret_key {
            NativeSecretKey::EcdsaK256Keccak(_) => AuthScheme::AuthEcdsaK256Keccak,
            NativeSecretKey::Falcon512Poseidon2(_) => AuthScheme::AuthRpoFalcon512,
            // This is because the definition of NativeSecretKey has the
            // '#[non_exhaustive]' attribute, without this catch-all clause,
            // this is a compiler error.
            _unimplemented => {
                return Err(from_str_err(
                    "building auth component for this auth scheme is not supported yet",
                ));
            },
        };

        Ok(AccountComponent::create_auth_component(commitment, auth_scheme))
    }

    #[js_export(js_name = "createAuthComponentFromCommitment")]
    pub fn create_auth_component_from_commitment(
        commitment: &Word,
        auth_scheme: AuthScheme,
    ) -> Result<AccountComponent, JsErr> {
        let native_word: NativeWord = commitment.into();
        let pkc = PublicKeyCommitment::from(native_word);

        Ok(AccountComponent::create_auth_component(pkc, auth_scheme))
    }

    /// Builds the auth component for a network account.
    ///
    /// A network account is a public account carrying this component: its
    /// note-script allowlist is the standardized storage slot the node's
    /// network-transaction builder inspects to identify the account as a network
    /// account and route matching notes to it for auto-consumption. The account
    /// may only consume notes whose script root is in `allowedNoteScriptFees` (obtain a
    /// root via `NoteScript.root()`).
    ///
    /// The canonical expiration transaction script is always allowlisted: the
    /// node's network-transaction builder attaches it to every network
    /// transaction, so an account without it could never be serviced.
    /// `allowedTxScriptRoots` allowlists further transaction script roots (from
    /// `TransactionScript.root()`) the account will execute. Allowlist a script
    /// root only if the script's effect is safe for *every* possible input: a
    /// root pins the script's code but not its arguments or advice inputs,
    /// which the (arbitrary) transaction submitter controls.
    ///
    /// Each entry in `allowedNoteScriptFees` carries both the allowlisted note script root and the
    /// fee the account charges to consume notes running it, so every allowlisted script is
    /// priced by construction. A fee of zero is valid; a script root the account does not price
    /// at all aborts fee estimation rather than being treated as free. Fees are denominated in
    /// the fungible asset issued by `feeFaucetId`.
    ///
    /// Returns the auth component together with the components backing its fee policy. Every one
    /// of them must be installed on the account: pass each to `AccountBuilder.withComponent`.
    ///
    /// # Errors
    /// Errors if `allowedNoteScriptFees` is empty, since a network account with no allowlisted note
    /// scripts could never consume a note.
    #[js_export(js_name = "createNetworkAuthComponents")]
    pub fn create_network_auth_components(
        allowed_note_script_fees: Vec<NoteScriptFee>,
        fee_faucet_id: &AccountId,
        allowed_tx_script_roots: Option<Vec<Word>>,
    ) -> Result<Vec<AccountComponent>, JsErr> {
        let mut note_roots: BTreeSet<NoteScriptRoot> = BTreeSet::new();
        let mut fee_policy = BasicConstantFeePolicy::new();

        // `AuthNetworkAccount::new` allowlists the config and fee-sponsorship note scripts on top
        // of the caller's roots. The caller cannot name those two, so price both at zero here to
        // keep fee estimation from aborting on them.
        fee_policy = fee_policy
            .with_fee(NetworkAccountConfigNote::script_root(), AssetAmount::ZERO)
            .with_fee(FeeSponsorshipNote::script_root(), AssetAmount::ZERO);

        for entry in &allowed_note_script_fees {
            let root = NoteScriptRoot::from_raw(NativeWord::from(&entry.script_root));
            let amount = AssetAmount::new(entry.amount)
                .map_err(|e| js_error_with_context(e, "invalid note fee amount"))?;
            note_roots.insert(root);
            fee_policy = fee_policy.with_fee(root, amount);
        }

        let fee_policy_manager = FeePolicyManager::builder()
            .fee_faucet_id(fee_faucet_id.into())
            .active_fee_policy(fee_policy.into())
            .build();

        let auth = AuthNetworkAccount::new(note_roots, fee_policy_manager).map_err(|e| {
            js_error_with_context(e, "Failed to create network account auth component")
        })?;

        // The network transaction builder attaches the canonical expiration script to every
        // network transaction it executes, so an account that does not allowlist that root could
        // never be serviced by the node.
        let mut tx_roots: BTreeSet<TransactionScriptRoot> =
            BTreeSet::from([ExpirationTransactionScript::script_root()]);
        tx_roots.extend(
            allowed_tx_script_roots
                .unwrap_or_default()
                .into_iter()
                .map(|root| TransactionScriptRoot::from_raw(NativeWord::from(&root))),
        );

        Ok(auth
            .with_allowed_tx_scripts(tx_roots)
            .into_iter()
            .map(AccountComponent)
            .collect())
    }

    /// Creates an account component from a compiled package and storage slots.
    #[js_export(js_name = "fromPackage")]
    pub fn from_package(
        package: &Package,
        storage_slots: StorageSlotArray,
    ) -> Result<AccountComponent, JsErr> {
        let native_package: NativePackage = package.into();
        let items: Vec<StorageSlot> = storage_slots.into();
        let native_slots: Vec<NativeStorageSlot> =
            items.into_iter().map(std::convert::Into::into).collect();

        NativeAccountComponent::new(
            native_package,
            native_slots,
            AccountComponentMetadata::new("custom"),
        )
        .map(AccountComponent)
        .map_err(|e| js_error_with_context(e, "Failed to create account component from package"))
    }

    /// Creates an account component from a compiled library and storage slots.
    #[js_export(js_name = "fromLibrary")]
    pub fn from_library(
        library: &Library,
        storage_slots: Vec<StorageSlot>,
    ) -> Result<AccountComponent, JsErr> {
        let native_library: NativePackage = library.into();
        let native_slots: Vec<NativeStorageSlot> =
            storage_slots.into_iter().map(Into::into).collect();

        NativeAccountComponent::new(
            native_library,
            native_slots,
            AccountComponentMetadata::new("custom"),
        )
        .map(AccountComponent)
        .map_err(|e| js_error_with_context(e, "Failed to create account component from library"))
    }
}

impl AccountComponent {
    fn create_auth_component(
        commitment: PublicKeyCommitment,
        auth_scheme: AuthScheme,
    ) -> AccountComponent {
        match auth_scheme {
            AuthScheme::AuthRpoFalcon512 => {
                let approver = Approver::new(commitment, NativeAuthSchemeId::Falcon512Poseidon2);
                let auth = NativeSingleSig::new(approver);
                AccountComponent(auth.into())
            },
            AuthScheme::AuthEcdsaK256Keccak => {
                let approver = Approver::new(commitment, NativeAuthSchemeId::EcdsaK256Keccak);
                let auth = NativeSingleSig::new(approver);
                AccountComponent(auth.into())
            },
        }
    }
}

// CONVERSIONS
// ================================================================================================

impl From<AccountComponent> for NativeAccountComponent {
    fn from(account_component: AccountComponent) -> Self {
        account_component.0
    }
}

impl From<NativeAccountComponent> for AccountComponent {
    fn from(native_account_component: NativeAccountComponent) -> Self {
        AccountComponent(native_account_component)
    }
}

impl From<&AccountComponent> for NativeAccountComponent {
    fn from(account_component: &AccountComponent) -> Self {
        account_component.0.clone()
    }
}

// `NoteScriptFee` is passed by value in a `Vec` to `createNetworkAuthComponents`, which napi only
// accepts for types implementing `FromNapiValue`.
impl_napi_from_value!(NoteScriptFee);
