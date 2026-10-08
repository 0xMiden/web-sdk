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

    /// Returns the well-known `FAUCET_POLICY_CONFIG` script, a management note that switches the
    /// consuming faucet's active mint, burn, send or receive policy through its
    /// `TokenPolicyManager` component. The new policy root must be one the manager allows for that
    /// kind, and the faucet's `Authority` component authorizes the switch. The note must be public
    /// and carry a `NetworkAccountTarget` attachment naming the consuming faucet.
    #[js_export(js_name = "faucetPolicyConfig")]
    pub fn faucet_policy_config() -> Self {
        StandardNote::FAUCET_POLICY_CONFIG.script().into()
    }

    /// Returns the well-known `PAUSE_CONFIG` script, a management note that pauses or unpauses
    /// the consuming account through its `PausableManager` component. The account's `Authority`
    /// component authorizes the action. The note must be public and carry a `NetworkAccountTarget`
    /// attachment naming the consuming account.
    #[js_export(js_name = "pauseConfig")]
    pub fn pause_config() -> Self {
        StandardNote::PAUSE_CONFIG.script().into()
    }

    /// Returns the well-known `OWNER_CONFIG` script, a management note that runs an
    /// `Ownable2Step` action on the consuming account: nominate a new owner (or cancel a pending
    /// nomination), accept a nomination, or renounce ownership. The note sender must be the party
    /// authorized for the action. The note must be public and carry a `NetworkAccountTarget`
    /// attachment naming the consuming account.
    #[js_export(js_name = "ownerConfig")]
    pub fn owner_config() -> Self {
        StandardNote::OWNER_CONFIG.script().into()
    }

    /// Returns the well-known `RBAC_CONFIG` script, a management note that runs a
    /// `RoleBasedAccessControl` action on the consuming account: grant, revoke or renounce a role,
    /// or set a role's admin role. The note sender must be the party authorized for the action.
    /// The note must be public and carry a `NetworkAccountTarget` attachment naming the consuming
    /// account.
    #[js_export(js_name = "rbacConfig")]
    pub fn rbac_config() -> Self {
        StandardNote::RBAC_CONFIG.script().into()
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
