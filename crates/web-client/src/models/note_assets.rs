use js_export_macro::js_export;
use miden_client::asset::Asset as NativeAsset;
use miden_client::note::NoteAssets as NativeNoteAssets;

use super::fungible_asset::FungibleAsset;
use crate::platform::{JsErr, from_str_err};

/// An asset container for a note.
///
/// A note must contain at least 1 asset and can contain up to `MAX_ASSETS_PER_NOTE` = 16 assets
/// (`miden_protocol::constants`). No duplicates are allowed, but the order of assets is
/// unspecified.
///
/// Constructors and `push` return a catchable `JsErr` on validation failure (too many assets or
/// duplicate fungible issuer) instead of trapping the WASM instance.
///
/// All the assets in a note can be reduced to a single commitment which is computed by sequentially
/// hashing the assets. Note that the same list of assets can result in two different commitments if
/// the asset ordering is different.
#[derive(Clone)]
#[js_export]
pub struct NoteAssets(NativeNoteAssets);

#[js_export]
impl NoteAssets {
    /// Creates a new asset list for a note.
    #[js_export(constructor)]
    pub fn new(assets_array: Option<Vec<FungibleAsset>>) -> Result<NoteAssets, JsErr> {
        let assets = assets_array.unwrap_or_default();
        let native_assets: Vec<NativeAsset> = assets.into_iter().map(Into::into).collect();
        native_note_assets(native_assets, "create NoteAssets").map(NoteAssets)
    }

    /// Adds a fungible asset to the collection.
    pub fn push(&mut self, asset: &FungibleAsset) -> Result<(), JsErr> {
        let mut assets: Vec<miden_client::asset::Asset> = self.0.iter().copied().collect();
        assets.push(asset.into());
        self.0 = native_note_assets(assets, "add note asset")?;
        Ok(())
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
