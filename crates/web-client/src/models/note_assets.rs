use js_export_macro::js_export;
use miden_client::asset::Asset as NativeAsset;
use miden_client::note::NoteAssets as NativeNoteAssets;

use super::asset::{AssetInput, VaultAsset, native_asset};
use super::fungible_asset::FungibleAsset;
use super::non_fungible_asset::NonFungibleAsset;
use crate::platform::{JsErr, from_str_err};

/// An asset container for a note.
///
/// A note can contain between 0 and 16 fungible or non-fungible assets. Duplicate assets are
/// rejected. Constructors and push methods return a catchable error if validation fails.
/// A failed push leaves the collection unchanged.
///
/// All the assets in a note can be reduced to a single commitment which is computed by sequentially
/// hashing the assets. Note that the same list of assets can result in two different commitments if
/// the asset ordering is different.
#[derive(Clone)]
#[js_export]
pub struct NoteAssets(NativeNoteAssets);

#[js_export]
impl NoteAssets {
    /// Creates a note asset list from an optional array of assets.
    ///
    /// Accepts `VaultAsset`, `FungibleAsset`, and `NonFungibleAsset` values in any combination. The
    /// default is an empty list. Input order is preserved. Returns an error if the list exceeds
    /// 16 assets or contains duplicate asset IDs. Input assets remain usable after this call.
    #[js_export(constructor)]
    pub fn new(assets_array: Option<Vec<AssetInput>>) -> Result<NoteAssets, JsErr> {
        let assets = assets_array.unwrap_or_default();
        let native_assets = assets.iter().map(native_asset).collect::<Result<Vec<_>, _>>()?;
        native_note_assets(native_assets, "create NoteAssets").map(NoteAssets)
    }

    /// Appends a `VaultAsset`, `FungibleAsset`, or `NonFungibleAsset` without consuming the input.
    /// Returns an error for a duplicate or a list longer than 16 assets.
    /// A failed push leaves the collection unchanged.
    pub fn push(&mut self, asset: AssetInput) -> Result<(), JsErr> {
        self.push_asset(native_asset(&asset)?)
    }

    /// Returns all assets in their stored order. Returns an empty array for an empty note.
    pub fn assets(&self) -> Vec<VaultAsset> {
        self.0.iter().copied().map(Into::into).collect()
    }

    /// Returns all non-fungible assets in the note, in their stored order.
    /// Returns an empty array if no non-fungible assets are present.
    #[js_export(js_name = "nonFungibleAssets")]
    pub fn non_fungible_assets(&self) -> Vec<NonFungibleAsset> {
        self.0
            .iter()
            .filter_map(|asset| {
                if asset.is_non_fungible() {
                    Some(asset.unwrap_non_fungible().into())
                } else {
                    None
                }
            })
            .collect()
    }

    /// Returns all fungible assets contained in the note.
    #[js_export(js_name = "fungibleAssets")]
    pub fn fungible_assets(&self) -> Vec<FungibleAsset> {
        self.0
            .iter()
            .filter_map(|asset| {
                if asset.is_fungible() {
                    Some(asset.unwrap_fungible().into())
                } else {
                    None
                }
            })
            .collect()
    }
}

impl NoteAssets {
    fn push_asset(&mut self, asset: NativeAsset) -> Result<(), JsErr> {
        let mut assets: Vec<NativeAsset> = self.0.iter().copied().collect();
        assets.push(asset);
        self.0 = native_note_assets(assets, "add note asset")?;
        Ok(())
    }
}

fn native_note_assets(assets: Vec<NativeAsset>, action: &str) -> Result<NativeNoteAssets, JsErr> {
    NativeNoteAssets::new(assets).map_err(|err| from_str_err(&format!("Failed to {action}: {err}")))
}

// CONVERSIONS
// ================================================================================================

impl From<NativeNoteAssets> for NoteAssets {
    fn from(native_note_assets: NativeNoteAssets) -> Self {
        NoteAssets(native_note_assets)
    }
}

impl From<&NativeNoteAssets> for NoteAssets {
    fn from(native_note_assets: &NativeNoteAssets) -> Self {
        NoteAssets(native_note_assets.clone())
    }
}

impl From<NoteAssets> for NativeNoteAssets {
    fn from(note_assets: NoteAssets) -> Self {
        note_assets.0
    }
}

impl From<&NoteAssets> for NativeNoteAssets {
    fn from(note_assets: &NoteAssets) -> Self {
        note_assets.0.clone()
    }
}
