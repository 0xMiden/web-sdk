use js_export_macro::js_export;
use miden_client::pswap::{
    PswapLineageRecord as NativePswapLineageRecord,
    PswapLineageState as NativePswapLineageState,
};

use super::account_id::AccountId;
use super::fungible_asset::FungibleAsset;
use super::note_id::NoteId;

/// Lifecycle state of a PSWAP order.
///
/// Discriminants match the on-disk encoding in the store.
#[js_export]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PswapLineageState {
    /// Still fillable and reclaimable.
    Active = 0,
    /// Fully filled. Terminal.
    FullyFilled = 1,
    /// Reclaimed by the creator. Terminal.
    Reclaimed = 2,
}

/// Read-only view of one PSWAP order's chain state, exposed to JavaScript.
/// The mutable fields (remaining amounts, depth, tip, state) advance
/// round-by-round as fills are discovered during sync.
#[derive(Clone)]
#[js_export]
pub struct PswapLineageRecord(NativePswapLineageRecord);

#[js_export]
impl PswapLineageRecord {
    /// Stable identifier shared by every note in the chain, as a decimal string.
    #[js_export(js_name = "orderId")]
    pub fn order_id(&self) -> String {
        self.0.order_id().as_canonical_u64().to_string()
    }

    /// Account that created the order and receives every payback.
    #[js_export(js_name = "creatorAccountId")]
    pub fn creator_account_id(&self) -> AccountId {
        self.0.creator_account_id().into()
    }

    /// Offered asset still unfilled on the current tip. Carries the offered
    /// faucet (chain-invariant across the order) and the remaining amount.
    #[js_export(js_name = "remainingOffered")]
    pub fn remaining_offered(&self) -> FungibleAsset {
        self.0.remaining_offered.into()
    }

    /// Requested asset still outstanding on the current tip. Carries the
    /// requested faucet (chain-invariant across the order) and the remaining
    /// amount.
    #[js_export(js_name = "remainingRequested")]
    pub fn remaining_requested(&self) -> FungibleAsset {
        self.0.remaining_requested.into()
    }

    /// Depth of the current tip: 0 for the original PSWAP, +1 per fill round.
    #[js_export(js_name = "currentDepth")]
    pub fn current_depth(&self) -> u32 {
        self.0.current_depth
    }

    /// Note id of the current tip in the chain.
    #[js_export(js_name = "currentTipNoteId")]
    pub fn current_tip_note_id(&self) -> NoteId {
        self.0.current_tip_note_id.into()
    }

    /// Lifecycle state of the order.
    pub fn state(&self) -> PswapLineageState {
        self.0.state.into()
    }

    /// Block at which the lineage was first recorded.
    #[js_export(js_name = "createdAtBlock")]
    pub fn created_at_block(&self) -> u32 {
        self.0.created_at_block.as_u32()
    }

    /// Block at which the lineage was last advanced.
    #[js_export(js_name = "updatedAtBlock")]
    pub fn updated_at_block(&self) -> u32 {
        self.0.updated_at_block.as_u32()
    }
}

// CONVERSIONS
// ================================================================================================

impl From<NativePswapLineageState> for PswapLineageState {
    fn from(value: NativePswapLineageState) -> Self {
        match value {
            NativePswapLineageState::Active => PswapLineageState::Active,
            NativePswapLineageState::FullyFilled => PswapLineageState::FullyFilled,
            NativePswapLineageState::Reclaimed => PswapLineageState::Reclaimed,
        }
    }
}

impl From<NativePswapLineageRecord> for PswapLineageRecord {
    fn from(record: NativePswapLineageRecord) -> Self {
        PswapLineageRecord(record)
    }
}

impl_napi_from_value!(PswapLineageRecord);
