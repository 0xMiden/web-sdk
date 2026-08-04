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

        // Relay with a block hint so the recipient scans from a deterministic block for the note's
        // on-chain commitment, instead of the narrow fixed lookback window it falls back to for
        // hint-less notes. That window silently drops the note for any recipient whose sync height
        // has advanced past it, so hint-less delivery is non-deterministic.
        //
        // The hint is the sender's current sync height. This is a safe hint ("any block at or
        // before the commitment is correct") for the intended flow: relaying right after
        // submitting the note's transaction, while the commitment is still ahead of the synced
        // tip. It assumes prompt relay — a caller that defers relay until the sender has synced
        // past the note's own commitment would produce a hint above the commitment, which the
        // recipient would not scan back to. The note's true creation block isn't reachable from a
        // bare `Note`, so the sync height is the best available lower bound for the normal path.
        let block_hint = client
            .get_sync_height()
            .await
            .map_err(|e| js_error_with_context(e, "failed reading block hint for private note"))?;

        client
            .send_private_note_with_block_hint(note.into(), &address.into(), block_hint)
            .await
            .map_err(|e| js_error_with_context(e, "failed sending private note"))?;

        Ok(())
    }

    /// Fetch private notes from the note transport layer
    ///
    /// Uses an internal pagination mechanism to avoid fetching duplicate notes.
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

    /// Fetch all private notes from the note transport layer
    ///
    /// Fetches all notes stored in the transport layer, with no pagination.
    /// Prefer using [`WebClient::fetch_private_notes`] for a more efficient, on-going,
    /// fetching mechanism.
    #[js_export(js_name = "fetchAllPrivateNotes")]
    pub async fn fetch_all_private_notes(&self) -> Result<(), JsErr> {
        let mut guard = self.get_mut_inner().await;
        let client = guard
            .as_mut()
            .ok_or_else(|| from_str_err("Client not initialized. Call createClient() first."))?;

        client
            .fetch_all_private_notes()
            .await
            .map_err(|e| js_error_with_context(e, "failed fetching all private notes"))?;

        Ok(())
    }
}
