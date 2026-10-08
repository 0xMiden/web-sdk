use js_export_macro::js_export;
use miden_client::PrettyPrint;
use miden_client::note::{NoteScript as NativeNoteScript, StandardNote};

use super::word::Word;
use crate::js_error_with_context;
use crate::models::package::Package;
use crate::platform::{JsBytes, JsErr};
use crate::utils::{deserialize_from_bytes, serialize_to_bytes};

/// An executable program of a note.
///
/// A note's script represents a program which must be executed for a note to be consumed. As such
/// it defines the rules and side effects of consuming a given note.
#[derive(Clone)]
#[js_export]
pub struct NoteScript(NativeNoteScript);

#[js_export]
impl NoteScript {
    /// Pretty-prints the MAST source for this script.
    #[js_export(js_name = toString)]
    #[allow(clippy::inherent_to_string)]
    pub fn to_string(&self) -> String {
        self.0.to_pretty_string()
    }

    /// Serializes the script into bytes.
    pub fn serialize(&self) -> JsBytes {
        serialize_to_bytes(&self.0)
    }

    /// Deserializes a script from bytes.
    pub fn deserialize(bytes: JsBytes) -> Result<NoteScript, JsErr> {
        deserialize_from_bytes::<NativeNoteScript>(&bytes).map(NoteScript)
    }

    /// Returns the well-known P2ID script.
    pub fn p2id() -> Self {
        StandardNote::P2ID.script().into()
    }

    /// Returns the Network Account Config script.
    #[js_export(js_name = "networkAccountConfig")]
    pub fn network_account_config() -> Self {
        StandardNote::NETWORK_ACCOUNT_CONFIG.script().into()
    }

    /// Returns the Fee Sponsorship script.
    #[js_export(js_name = "feeSponsorship")]
    pub fn fee_sponsorship() -> Self {
        StandardNote::FEE_SPONSORSHIP.script().into()
    }

    /// Returns the well-known P2IDE script (P2ID with execution hint).
    pub fn p2ide() -> Self {
        StandardNote::P2IDE.script().into()
    }

    /// Returns the well-known SWAP script.
    pub fn swap() -> Self {
        StandardNote::SWAP.script().into()
    }

    /// Returns the well-known PSWAP script (partial-fill swap).
    pub fn pswap() -> Self {
        StandardNote::PSWAP.script().into()
    }

    /// Returns the well-known MINT script (instructs a network fungible faucet to mint a
    /// fungible asset — MINT notes are consumable only by network faucets).
    pub fn mint() -> Self {
        StandardNote::MINT.script().into()
    }

    /// Returns the well-known BURN script (instructs a faucet to burn a fungible asset).
    pub fn burn() -> Self {
        StandardNote::BURN.script().into()
    }

    /// Returns the well-known `FAUCET_POLICY_CONFIG` script. It runs on a faucet with
    /// `TokenPolicyManager` and `Authority`, from a public note whose `NetworkAccountTarget` names
    /// that faucet. See `miden_standards::note::config::FaucetPolicyConfigNote`.
    #[js_export(js_name = "faucetPolicyConfig")]
    pub fn faucet_policy_config() -> Self {
        StandardNote::FAUCET_POLICY_CONFIG.script().into()
    }

    /// Returns the well-known `PAUSE_CONFIG` script. It runs on an account with `PausableManager`,
    /// `Pausable` and `Authority`, from a public note whose `NetworkAccountTarget` names that
    /// account. See `miden_standards::note::config::PauseConfigNote`.
    #[js_export(js_name = "pauseConfig")]
    pub fn pause_config() -> Self {
        StandardNote::PAUSE_CONFIG.script().into()
    }

    /// Returns the well-known `OWNER_CONFIG` script. It runs on an account with `Ownable2Step`,
    /// from a public note whose `NetworkAccountTarget` names that account. See
    /// `miden_standards::note::config::OwnerConfigNote`.
    #[js_export(js_name = "ownerConfig")]
    pub fn owner_config() -> Self {
        StandardNote::OWNER_CONFIG.script().into()
    }

    /// Returns the well-known `RBAC_CONFIG` script. It runs on an account with
    /// `RoleBasedAccessControl`, from a public note whose `NetworkAccountTarget` names that
    /// account. See `miden_standards::note::config::RbacConfigNote`.
    #[js_export(js_name = "rbacConfig")]
    pub fn rbac_config() -> Self {
        StandardNote::RBAC_CONFIG.script().into()
    }

    /// Returns the well-known `CONSTANT_FEE_POLICY_CONFIG` script. It runs on a network account
    /// with `ConstantFeeManager` and an owner- or role-controlled `Authority`, from a public note
    /// whose `NetworkAccountTarget` names that account. See
    /// `miden_standards::note::config::ConstantFeePolicyConfigNote`.
    #[js_export(js_name = "constantFeePolicyConfig")]
    pub fn constant_fee_policy_config() -> Self {
        StandardNote::CONSTANT_FEE_POLICY_CONFIG.script().into()
    }

    /// Returns the well-known `FAUCET_METADATA_CONFIG` script. It runs on a `FungibleFaucet` or
    /// `NonFungibleFaucet` account with `Authority` (its max-supply action on a fungible faucet
    /// only), from a public note whose `NetworkAccountTarget` names that faucet. See
    /// `miden_standards::note::config::FaucetMetadataConfigNote`.
    #[js_export(js_name = "faucetMetadataConfig")]
    pub fn faucet_metadata_config() -> Self {
        StandardNote::FAUCET_METADATA_CONFIG.script().into()
    }

    /// Returns the well-known `MIN_BURN_AMOUNT_CONFIG` script. It runs on a faucet with
    /// `MinBurnAmount` and `Authority`, from a public note whose `NetworkAccountTarget` names that
    /// faucet. See `miden_standards::note::config::MinBurnAmountConfigNote`.
    #[js_export(js_name = "minBurnAmountConfig")]
    pub fn min_burn_amount_config() -> Self {
        StandardNote::MIN_BURN_AMOUNT_CONFIG.script().into()
    }

    /// Returns the well-known `ALLOWLIST_CONFIG` script. It runs on an account with
    /// `AllowlistManager`, `BasicAllowlist` (or another component holding the allowed accounts)
    /// and `Authority`, from a public note whose `NetworkAccountTarget` names that account. See
    /// `miden_standards::note::config::AllowlistConfigNote`.
    #[js_export(js_name = "allowlistConfig")]
    pub fn allowlist_config() -> Self {
        StandardNote::ALLOWLIST_CONFIG.script().into()
    }

    /// Returns the well-known `BLOCKLIST_CONFIG` script. It runs on an account with
    /// `BlocklistManager`, `BasicBlocklist` (or another component holding the blocked accounts)
    /// and `Authority`, from a public note whose `NetworkAccountTarget` names that account. See
    /// `miden_standards::note::config::BlocklistConfigNote`.
    #[js_export(js_name = "blocklistConfig")]
    pub fn blocklist_config() -> Self {
        StandardNote::BLOCKLIST_CONFIG.script().into()
    }

    /// Returns the well-known `UPGRADE` script. It runs on an account with `UpgradeManager` and
    /// `Authority`, from a public note whose `NetworkAccountTarget` names that account. See
    /// `miden_standards::note::UpgradeNote`.
    pub fn upgrade() -> Self {
        StandardNote::UPGRADE.script().into()
    }

    /// Returns the well-known `TX_FEE` script. Any account may consume it, and its assets stay in
    /// the note, so the consuming account's own code must move them out. See
    /// `miden_standards::note::TxFeeNote`.
    #[js_export(js_name = "txFee")]
    pub fn tx_fee() -> Self {
        StandardNote::TX_FEE.script().into()
    }

    /// Returns the MAST root of this script.
    ///
    /// The root is the script's MAST commitment — the identifier used on-chain to reference
    /// the script (e.g. `NoteScript.burn().root().toHex()` gives the standard burn note
    /// script root). It is fixed for a given protocol / standards-library version, but a
    /// protocol upgrade that changes the compiled script changes the root, so treat it as
    /// version-specific rather than a permanent constant.
    pub fn root(&self) -> Word {
        miden_client::Word::from(self.0.root()).into()
    }

    /// Creates a `NoteScript` from the given `Package`.
    /// The package must contain a library with exactly one procedure annotated with
    /// `@note_script`.
    #[js_export(js_name = "fromPackage")]
    pub fn from_package(package: &Package) -> Result<NoteScript, JsErr> {
        let native_package: miden_client::vm::Package = package.into();
        let native_note_script = NativeNoteScript::from_package(&native_package)
            .map_err(|e| js_error_with_context(e, "failed to create note script from package"))?;
        Ok(native_note_script.into())
    }
}
// CONVERSIONS
// ================================================================================================

impl From<NativeNoteScript> for NoteScript {
    fn from(native_note_script: NativeNoteScript) -> Self {
        NoteScript(native_note_script)
    }
}

impl From<&NativeNoteScript> for NoteScript {
    fn from(native_note_script: &NativeNoteScript) -> Self {
        NoteScript(native_note_script.clone())
    }
}

impl From<NoteScript> for NativeNoteScript {
    fn from(note_script: NoteScript) -> Self {
        note_script.0
    }
}

impl From<&NoteScript> for NativeNoteScript {
    fn from(note_script: &NoteScript) -> Self {
        note_script.0.clone()
    }
}
