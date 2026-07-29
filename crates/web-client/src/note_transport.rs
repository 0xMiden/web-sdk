use js_export_macro::js_export;

use crate::platform::{JsErr, from_str_err};
use crate::{WebClient, js_error_with_context};

#[js_export]
impl WebClient {
    /// Send a private note via the note transport layer
    #[js_export(js_name = "sendPrivateNote")]
    pub async fn send_private_note(
        &self,
        note: crate::models::note::Note,
        address: crate::models::address::Address,
    ) -> Result<(), JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| from_str_err("Client not initialized. Call createClient() first."))?;

        // Relay the client's current sync height as the block hint so the recipient gets
        // deterministic delivery (scanning from that block) instead of a fixed lookback window.
        let block_hint = client
            .get_sync_height()
            .await
            .map_err(|e| js_error_with_context(e, "failed to read sync height"))?;
        client
            .send_private_note_with_block_hint(note.into(), &address.into(), block_hint)
            .await
            .map_err(|e| js_error_with_context(e, "failed sending private note"))?;

        Ok(())
    }

    /// Fetch private notes from the note transport layer
    ///
    /// Uses an internal pagination mechanism to avoid fetching duplicate notes: only notes past
    /// the stored cursor are fetched. Historical notes for a newly tracked tag sit below that
    /// cursor and are recovered automatically during `syncState`, which backfills each new tag.
    #[js_export(js_name = "fetchPrivateNotes")]
    pub async fn fetch_private_notes(&self) -> Result<(), JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| from_str_err("Client not initialized. Call createClient() first."))?;

        client
            .fetch_private_notes()
            .await
            .map_err(|e| js_error_with_context(e, "failed fetching private notes"))?;

        Ok(())
    }
}
