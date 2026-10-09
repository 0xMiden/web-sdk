use js_export_macro::js_export;
use miden_client::Felt as NativeFelt;
use miden_client::pswap::PswapLineageState as NativePswapLineageState;

use crate::models::account_id::AccountId;
use crate::models::pswap_lineage_record::PswapLineageRecord;
use crate::models::transaction_request::TransactionRequest;
use crate::platform::{JsErr, from_str_err};
use crate::{WebClient, js_error_with_context};

#[js_export]
impl WebClient {
    /// Returns every PSWAP lineage tracked by this client.
    #[js_export(js_name = "getPswapLineages")]
    pub async fn get_pswap_lineages(&self) -> Result<Vec<PswapLineageRecord>, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| from_str_err("Client not initialized while fetching pswap lineages"))?;
        let lineages = client
            .pswap_lineages()
            .await
            .map_err(|err| js_error_with_context(err, "failed to fetch pswap lineages"))?;
        Ok(lineages.into_iter().map(PswapLineageRecord::from).collect())
    }

    /// Returns lineages created by a specific local account.
    #[js_export(js_name = "getPswapLineagesFor")]
    pub async fn get_pswap_lineages_for(
        &self,
        creator: &AccountId,
    ) -> Result<Vec<PswapLineageRecord>, JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| from_str_err("Client not initialized while fetching pswap lineages"))?;
        let lineages = client.pswap_lineages_for(creator.into()).await.map_err(|err| {
            js_error_with_context(err, "failed to fetch pswap lineages for account")
        })?;
        Ok(lineages.into_iter().map(PswapLineageRecord::from).collect())
    }

    /// Returns the lineage for one order, or `null` if not tracked.
    ///
    /// `order_id` is the order's stable identifier as a decimal string.
    #[js_export(js_name = "getPswapLineage")]
    pub async fn get_pswap_lineage(
        &self,
        order_id: String,
    ) -> Result<Option<PswapLineageRecord>, JsErr> {
        let order_id = parse_order_id(&order_id)?;
        let mut guard = self.get_mut_inner().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| from_str_err("Client not initialized while fetching pswap lineage"))?;
        client
            .pswap_lineage(order_id)
            .await
            .map(|opt| opt.map(PswapLineageRecord::from))
            .map_err(|err| js_error_with_context(err, "failed to fetch pswap lineage"))
    }

    /// Builds a transaction reclaiming the unfilled offered asset on the current
    /// tip of an Active lineage.
    ///
    /// `order_id` is the order's stable identifier as a decimal string. The
    /// returned request flows into the same submit path as the other PSWAP
    /// cancel transactions.
    #[js_export(js_name = "buildPswapCancelByOrder")]
    pub async fn build_pswap_cancel_by_order(
        &self,
        order_id: String,
    ) -> Result<TransactionRequest, JsErr> {
        let order_felt = parse_order_id(&order_id)?;
        let mut guard = self.get_mut_inner().await;
        let client = guard.as_mut().ok_or_else(|| {
            from_str_err("Client not initialized while building pswap cancel transaction request")
        })?;

        // Terminal-state guard at the lowest shared layer (raw binding,
        // `pswap.js`, and the React hook all reach it). A FullyFilled/Reclaimed
        // lineage has no fillable tip — a cancel against it would die at
        // execution with "note already nullified"; throw early instead.
        let lineage = client
            .pswap_lineage(order_felt)
            .await
            .map_err(|err| js_error_with_context(err, "failed to fetch pswap lineage"))?
            .ok_or_else(|| {
                from_str_err(&format!("No PSWAP lineage tracked for order {order_id}"))
            })?;
        let terminal_state = match lineage.state {
            NativePswapLineageState::Active => None,
            NativePswapLineageState::FullyFilled => Some("FullyFilled"),
            NativePswapLineageState::Reclaimed => Some("Reclaimed"),
        };
        if let Some(state_name) = terminal_state {
            return Err(from_str_err(&format!(
                "Cannot cancel PSWAP order {order_id}: lineage is {state_name}; \
                 only Active lineages can be cancelled."
            )));
        }

        client
            .build_pswap_cancel_by_order(order_felt)
            .await
            .map(Into::into)
            .map_err(|err| {
                js_error_with_context(
                    err,
                    "failed to build pswap cancel-by-order transaction request",
                )
            })
    }
}

/// Parses a decimal `order_id` string into a field element.
///
/// A valid id is a decimal integer in the `u64` range that is also a valid field
/// element (i.e. below the field modulus). Values that parse as `u64` but lie at
/// or above the modulus are rejected by the field-element check, not the parse.
fn parse_order_id(order_id: &str) -> Result<NativeFelt, JsErr> {
    let value = order_id.parse::<u64>().map_err(|_| {
        from_str_err("invalid order_id: expected a decimal integer in the u64 range")
    })?;
    NativeFelt::new(value).map_err(|err| {
        from_str_err(&format!("invalid order_id {value}: not a valid field element ({err})"))
    })
}
